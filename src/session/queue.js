function createQueue({
  limit = 20,
  canWrite = () => true,
  write,
  onOverflow = () => {},
  onError = () => {},
}) {
  const items = [];
  let inFlight = false;

  function pump() {
    if (inFlight || items.length === 0 || !canWrite()) return;
    const item = items.shift();
    inFlight = true;
    try {
      write(item);
    } catch (err) {
      inFlight = false;
      // 放回队头：write 抛错多半是进程刚退出、onExit 还没投递，这条已经 shift
      // 出来的消息如果不放回去，dropQueue 统计不到它，手机端只收到过「已排队」，
      // 消息就这么没了。留在队列里，进程真死了会走 queue-dropped 提示，没死就下一轮重试。
      items.unshift(item);
      onError(err);
    }
  }

  return {
    push(item) {
      if (items.length + (inFlight ? 1 : 0) >= limit) {
        onOverflow(item);
        return 'full';
      }
      items.push(item);
      pump();
      return 'queued';
    },
    release() {
      inFlight = false;
      pump();
    },
    pending() {
      return items.length;
    },
    inFlight() {
      return inFlight;
    },
    size() {
      return items.length + (inFlight ? 1 : 0);
    },
    drain() {
      const rest = items.splice(0);
      return rest;
    },
  };
}

module.exports = { createQueue };
