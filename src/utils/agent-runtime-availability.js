// Keep this policy aligned with the launch routes. These flags describe operator
// maintenance, never the buyer's credentials or subscription.
function runtimeAvailability(agentId, env = process.env) {
  const id = String(agentId || '').toLowerCase();
  const paused = id === 'nanoclaw' ? env.NANOCLAW_BUYER_RUNTIME_ENABLED !== '1'
    : id === 'hermes' ? env.HERMES_BUYER_RUNTIME_ENABLED === '0'
    : id === 'spacebot' ? env.SPACEBOT_BUYER_RUNTIME_ENABLED === '0' : false;
  return paused ? {
    available: false,
    code: 'RUNTIME_ISOLATION_MAINTENANCE',
    message: 'Agent đang tạm ngưng để tách biệt môi trường, dữ liệu và API key giữa người dùng. Không cần thay API key. Thuê mới và gia hạn tạm dừng trong thời gian này.',
  } : { available: true };
}
function assertRuntimeAvailable(agentId) {
  const status = runtimeAvailability(agentId);
  if (!status.available) {
    const err = new Error(status.message);
    err.status = 503;
    err.code = status.code;
    throw err;
  }
}
module.exports = { runtimeAvailability, assertRuntimeAvailable };
