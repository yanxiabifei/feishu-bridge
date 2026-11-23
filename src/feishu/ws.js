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
}) {
  const Lark = sdk || require('@larksuiteoapi/node-sdk');
  log = log ?? {};
  dedup = dedup ?? createDedup();
  domain = domain ?? Lark.Domain.Feishu;

  function errText(err) {
    return err instanceof Error ? err.message : String(err);
  }

  function dispatch(name, data) {
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
  });

  return {
    start: () => client.start({ eventDispatcher: dispatcher }),
    close: () => client.close(),
  };
}

module.exports = { createFeishuWs, createDedup };
