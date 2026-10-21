/**
 * Quy chế 2.1 (05/10/2026): the Work board (job posts, applications, talent CVs, contracts) and
 * the quote-based Hire projects flow are discontinued and replaced by fixed-package professional
 * services sold as regular products. All their endpoints answer 410 Gone. Nothing is deleted;
 * see `npm run report:legacy-work` for what is left in the database.
 */

// Fully shut down (user decision 12/10/2026): every Work and Hire endpoint answers 410,
// including existing jobs, contracts and hire projects. Data is kept untouched in MongoDB.
const WORK_BLOCKED = [['*', /^\/.*/]];
// 15/10/2026: professional-service packages are paid per phase (Đề án / Quy chế: thuê talent theo
// giai đoạn). Only the legacy quote/negotiation entry points stay closed; package projects
// (POST /packages) and their phase actions are open again.
const HIRE_BLOCKED = [
  ['POST', /^\/projects\/?$/],
  ['POST', /^\/projects\/[^/]+\/(quote|counter|decline|accept)\/?$/],
];

function matches(rules, req) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  return rules.some(([m, re]) => (m === '*' || m === method) && re.test(path));
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
