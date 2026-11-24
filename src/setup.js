const { createApi: defaultCreateApi } = require('./feishu/api');
const { createFeishuWs: defaultCreateWs } = require('./feishu/ws');
const { loadConfig, saveConfig } = require('./config');
const { noticeCard } = require('./feishu/cards');

const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

const HINTS = {
  10003: 'App ID 不存在，去「凭证与基础信息」重新复制。',
  10014: 'App Secret 不正确，去「凭证与基础信息」重置后复制。',
  99991663: '应用未发布：去「版本管理与发布」创建版本并申请发布，等审核通过。',
  99991672: '权限不足：去「权限管理」勾选 im:chat、im:message、cardkit:card，然后发布新版本。',
  99991679: '权限不足（事件/长连接）：确认「事件与回调」的连接方式是「长连接」。',
};

function hintFor(err) {
  const hint = HINTS[err && err.code];
  return hint ? `（${hint}）` : '';
}

function durationText(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} ${durationText(ms)}后仍未完成`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createSetup({
  prompt,
  createApi = defaultCreateApi,
  createWs = defaultCreateWs,
  loadConfigFn = loadConfig,
  saveConfigFn = saveConfig,
  secretStore,
  configPath,
  log = console,
  timeoutMs = 120000,
  print = () => {},
}) {
  const steps = [];

  function record(name, ok, detail = '') {
    steps.push({ name, ok, detail });
    print(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  async function run() {
    steps.length = 0;
    print('打开 https://open.feishu.cn/app → 选你的应用 →「凭证与基础信息」，复制 App ID 与 App Secret。');

    const appId = String((await prompt('App ID（cli_ 开头）：')) ?? '').trim();
    if (!APP_ID_RE.test(appId)) {
      record('App ID 格式', false, '应形如 cli_0123456789abcdef（cli_ + 16 位十六进制）');
      return { ok: false, steps };
    }
    record('App ID 格式', true, appId);

    const appSecret = String((await prompt('App Secret：')) ?? '').trim();
    if (!appSecret) {
      record('App Secret', false, '不能为空');
      return { ok: false, steps };
    }

    const api = createApi({ appId, appSecret });

    try {
      await api.getToken();
      record('换取 tenant_access_token', true, '凭据有效');
    } catch (err) {
      record('换取 tenant_access_token', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    try {
      const info = await api.getBotInfo();
      record('读取机器人信息', true, (info && info.app_name) || 'ok');
    } catch (err) {
      record('读取机器人信息', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    print('现在用手机飞书给机器人发一条私聊消息（随便什么字都行）…');
    let resolveMsg;
    const got = new Promise((resolve) => { resolveMsg = resolve; });
    const ws = createWs({
      appId,
      appSecret,
      log,
      handlers: { onMessage: (evt) => resolveMsg(evt) },
    });
    let wsStartError = null;
    Promise.resolve(ws.start()).catch((err) => {
      wsStartError = err;
      resolveMsg(null);
    });

    let evt;
    try {
      evt = await withTimeout(got, timeoutMs, '等待手机消息');
    } catch (err) {
      record('长连接收到消息', false,
        `${err.message}。请检查：订阅了 im.message.receive_v1、连接方式选「长连接」、应用已发布且你自己可用`);
      return { ok: false, steps };
    } finally {
      Promise.resolve(ws.close()).catch(() => {});
    }

    if (wsStartError) {
      record('长连接收到消息', false, `长连接启动失败：${wsStartError.message}`);
      return { ok: false, steps };
    }

    const chatId = evt && evt.message && evt.message.chat_id;
    const openId = evt && evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id;
    const chatType = evt && evt.message && evt.message.chat_type;
    if (!chatId || !openId) {
      record('长连接收到消息', false, '事件里缺少 chat_id / open_id，检查是否订阅了 im.message.receive_v1');
      return { ok: false, steps };
    }
    if (chatType !== 'p2p') {
      record('长连接收到消息', false, `收到的是群消息（chat_type=${chatType}），请改成跟机器人私聊`);
      return { ok: false, steps };
    }
    record('长连接收到消息', true, `chat_id=${chatId} open_id=${openId}`);

    let groupId;
    try {
      groupId = await api.createGroup(`飞书桥自测 ${new Date().toLocaleTimeString()}`, [openId]);
      record('创建测试群', true, groupId);
    } catch (err) {
      record('创建测试群', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    try {
      await api.sendText(groupId, '桥接测试：这条消息来自你的电脑。');
      record('发送文本消息', true);
    } catch (err) {
      record('发送文本消息', false, `${err.message}${hintFor(err)}`);
      try { await api.disbandChat(groupId); } catch { /* 清理失败不覆盖主错误 */ }
      return { ok: false, steps };
    }

    try {
      await api.sendCard(groupId, noticeCard({
        title: '卡片测试',
        text: '能看到这张卡片，说明卡片通道正常（按钮和「当前画面」都靠它）。',
      }));
      record('发送卡片消息', true);
    } catch (err) {
      record('发送卡片消息', false, `${err.message}${hintFor(err)}（可先不管：卡片失败只影响按钮，回复文字仍可用）`);
    }

    try {
      await api.disbandChat(groupId);
      record('解散测试群', true, groupId);
    } catch (err) {
      record('解散测试群', false, `${err.message}（手动删掉这个群即可）`);
    }

    secretStore.save(appSecret);
    saveConfigFn(configPath, {
      ...loadConfigFn(configPath),
      appId,
      ownerOpenId: openId,
      ownerChatId: chatId,
    });
    record('写入配置', true, `${configPath}（Secret 已单独加密保存）`);

    return { ok: true, steps };
  }

  return { run };
}

module.exports = { createSetup };
