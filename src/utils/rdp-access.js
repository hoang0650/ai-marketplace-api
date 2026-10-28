const net = require('net');
const { openSecret } = require('./secret-box');
function connection(session) {
  if (session.status !== 'live' || !session.rdpPrivatePort || !net.isIP(session.rdpHost) || !(session.rdpPort > 0 && session.rdpPort < 65536)) return null;
  const host = net.isIPv6(session.rdpHost) ? `[${session.rdpHost}]` : session.rdpHost;
  return { address: `${host}:${session.rdpPort}`, username: 'player', operatingSystem: 'Linux XFCE' };
}
function credentials(session) {
  const info = connection(session);
  if (!info || !session.rdpPasswordEncrypted) return null;
  return { ...info, password: openSecret(session.rdpPasswordEncrypted) };
}
function profile(session) {
  const info = connection(session);
  if (!info) return null;
  return Buffer.from('\ufeff' + [`full address:s:${info.address}`, 'username:s:player', 'prompt for credentials:i:1', 'screen mode id:i:2', 'authentication level:i:2', 'redirectclipboard:i:1', 'redirectprinters:i:0', 'audiomode:i:0', ''].join('\r\n'), 'utf16le');
}
module.exports = { connection, credentials, profile };
