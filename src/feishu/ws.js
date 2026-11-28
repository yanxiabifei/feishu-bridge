function createDedup({ ttl = 10 * 60 * 1000, max = 5000, now = () => Date.now() } = {}) {
  const seen = new Map();

  function sweep(t) {
    for (const [key, at] of seen) {
      if (t - at > ttl) seen.delete(key);
    }
  }

  return {
    isDuplicate(id) {
      if (!id || max <= 0) return false;
      const t = now();
      if (seen.size >= max) sweep(t);
      const prev = seen.get(id);
      if (prev !== undefined && t - prev <= ttl) return true;
      while (seen.size >= max) seen.delete(seen.keys().next().value);
      seen.set(id, t);
      return false;
    },
    size: () => seen.size,
  };
}

/**
 * handlers 约定：
 *   onMessage(data)       —— im.message.receive_v1
 *   onDisbanded(data)     —— im.chat.disbanded_v1
 *   onBotRemoved(data)    —— im.chat.member.bot.deleted_v1
 *   onBotAdded(data)      —— im.chat.member.bot.added_v1（自己把机器人拉进群 → 发自我介绍）
 *   onCardAction(data)    —— card.action.trigger
 *
 * 处理器只做「入队」这类立即返回的事，重活由调用方自己的串行队列完成，
 * 这样飞书 3 秒 ack 窗口不会被拖爆。
 */
function createFeishuWs({
  appId,
  appSecret,
  sdk,
  handlers = {},
  log,
  dedup,
  domain,
  onTerminal,
}) {
  const Lark = sdk || require('@larksuiteoapi/node-sdk');
  log = log ?? {};
  dedup = dedup ?? createDedup();
  domain = domain ?? Lark.Domain.Feishu;

  function errText(err) {
    return err instanceof Error ? err.message : String(err);
  }

  function dispatch(name, data) {
    // 消息没反应时，没有这条日志就分不清「飞书没推」还是「被规则丢了」。
    const msg = data && data.message;
    log?.info?.('ws.event', {
      name,
      chatId: (msg && msg.chat_id) || (data && data.chat_id) || null,
      chatType: (msg && msg.chat_type) || null,
      mentioned: Boolean(msg && Array.isArray(msg.mentions) && msg.mentions.length),
      msgType: (msg && msg.message_type) || null,
    });
    if (data && data.event_id && dedup.isDuplicate(data.event_id)) {
      log?.debug?.(`ws: duplicate ${name} ${data.event_id}`);
      return;
    }
    const fn = handlers[name];
    if (!fn) return;
    try {
      const ret = fn(data);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => log?.error?.(`ws: handler ${name} failed: ${errText(err)}`));
      }
    } catch (err) {
      log?.error?.(`ws: handler ${name} threw: ${errText(err)}`);
    }
  }

  // SDK 1.77 用 `params.loggerLevel || LoggerLevel.info` 取级别，fatal(0) 会被
  // 当成 falsy 回落成 info；额外传空 logger 才能真正静默。
  const noopLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const dispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.fatal,
    logger: noopLogger,
  });
  dispatcher.register({
    'im.message.receive_v1': (data) => dispatch('onMessage', data),
    'im.chat.disbanded_v1': (data) => dispatch('onDisbanded', data),
    'im.chat.member.bot.deleted_v1': (data) => dispatch('onBotRemoved', data),
    'im.chat.member.bot.added_v1': (data) => dispatch('onBotAdded', data),
    'card.action.trigger': (data) => dispatch('onCardAction', data),
  });

  const client = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.fatal,
    domain,
    // SDK 只在「重试也救不回来」时才回调 onError（凭据被拒、重连次数耗尽）。
    // 之后它不会再自己连，不喊一声的话守护进程会一直跑着但收不到任何消息。
    onError: (err) => {
      const message = errText(err);
      log?.error?.(`ws 长连接已放弃重连（SDK 终态）：${message}`);
      try {
        onTerminal?.(err);
      } catch (e) {
        log?.warn?.(`ws: onTerminal 处理失败：${errText(e)}`);
      }
    },
  });

  return {
    start: async () => {
      // SDK 自己只检查格式、写一句日志就 return，调用方会以为连上了。
      // 这里的 App ID 是唯一的凭据入口，格式不对永远连不上，直接报错更好。
      if (!/^cli_[0-9a-fA-F]{16}$/.test(String(appId || ''))) {
        throw new Error('飞书 App ID 格式不对（应为 cli_ 加 16 位十六进制），请检查 config.json');
      }
      return client.start({ eventDispatcher: dispatcher });
    },
    close: () => client.close(),
    // 旧版 SDK 没有 getConnectionStatus，拿不到就返回 null，由调用方显示「未知」
    status: () => (typeof client.getConnectionStatus === 'function'
      ? client.getConnectionStatus()
      : null),
  };
}

module.exports = { createFeishuWs, createDedup };
