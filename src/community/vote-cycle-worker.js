/** Closes the previous community vote cycle once (VOTE_CYCLE monthly|weekly). VOTE_CYCLE_WORKER=off disables. */
const { createVoteService } = require('./agent-vote-service');
const { createMongoRepo } = require('./mongo-repo');

let timer = null;

function startVoteCycleWorker({ tickMs = 10 * 60 * 1000 } = {}) {
  if (timer) return;
  const svc = createVoteService({ repo: createMongoRepo() });
  const tick = async () => {
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return;
      const r = await svc.closeCycle({ manual: false });
      if (r.closed) console.log(`[vote] closed cycle ${r.cycle.key} winner=${r.cycle.winner || 'none'}`);
    } catch (e) {
      console.error('[vote] cycle close failed:', e.message);
    }
  };
  setTimeout(tick, 30_000).unref?.();
  timer = setInterval(tick, tickMs);
  timer.unref?.();
}

function stopVoteCycleWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startVoteCycleWorker, stopVoteCycleWorker };
