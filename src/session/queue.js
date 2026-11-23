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
      inFlight = false;
      return rest;
    },
  };
}

module.exports = { createQueue };
