/** Serialize mongoose docs to frontend shape: { id, ... } without _id/__v */
function toClient(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const id = obj.id || (obj._id ? String(obj._id) : undefined);
  delete obj._id;
  delete obj.__v;
  delete obj.passwordHash;
  if (id) obj.id = id;
  return obj;
}

function toClientList(docs) {
  return (docs || []).map(toClient);
}

function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

module.exports = { toClient, toClientList, slugify };
