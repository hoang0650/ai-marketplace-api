/**
 * Quy chế 2.1 (05/10/2026): the Work board (job posts, applications, talent CVs) and the
 * quote-based Hire projects flow are discontinued and replaced by fixed-package professional
 * services sold as regular products. New activity is refused with 410 Gone; read access and
 * actions that let already-funded jobs/projects finish (deliver, approve, revision, cancel,
 * terminate…) stay available so no user money or data is stranded. Nothing is deleted.
 */

const WORK_BLOCKED = [
  ['GET', /^\/fields\/?$/],
  ['GET', /^\/listing-fee\/?$/],
  ['GET', /^\/jobs\/?$/],
  ['GET', /^\/jobs\/[^/]+\/bids\/?$/],
  ['GET', /^\/talents(\/[^/]+)?\/?$/],
  ['POST', /^\/jobs\/?$/],
  ['POST', /^\/jobs\/[^/]+\/applications\/?$/],
  ['POST', /^\/talents\/?$/],
  ['PUT', /^\/talents\/[^/]+\/?$/],
];

const HIRE_BLOCKED = [
  ['POST', /^\/projects\/?$/],
  ['POST', /^\/projects\/[^/]+\/(quote|counter|accept)\/?$/],
];

function matches(rules, req) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  return rules.some(([m, re]) => m === method && re.test(path));
}

function discontinued(rules, code, message) {
  return (req, res, next) => {
    if (!matches(rules, req)) return next();
    return res.status(410).json({ message, code, replacement: '/v1/products?navGroup=talent' });
  };
}

const workDiscontinued = discontinued(
  WORK_BLOCKED,
  'WORK_DISCONTINUED',
  'Tính năng Việc làm / tuyển dụng đã ngừng. Vui lòng dùng Dịch vụ chuyên môn trọn gói.',
);

const hireDiscontinued = discontinued(
  HIRE_BLOCKED,
  'HIRE_PROJECTS_DISCONTINUED',
  'Thuê theo dự án (báo giá) đã ngừng. Dịch vụ chuyên môn nay được bán theo gói giá cố định và thanh toán bằng ví.',
);

module.exports = { workDiscontinued, hireDiscontinued, WORK_BLOCKED, HIRE_BLOCKED, matches };
