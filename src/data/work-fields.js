/** Professional fields for job/talent filters (GC Work style). */
const WORK_FIELDS = [
  {
    id: 'ai',
    label: 'AI & Trí tuệ nhân tạo',
    children: [
      { id: 'ai-content', label: 'AI Content' },
      { id: 'ai-image', label: 'AI Image' },
      { id: 'ai-video', label: 'AI Video' },
      { id: 'ai-bot', label: 'Bot & Chatbot AI' },
      { id: 'ai-automation', label: 'AI Automation' },
      { id: 'ai-integration', label: 'AI Integration' },
    ],
  },
  {
    id: 'it',
    label: 'IT và lập trình',
    children: [
      { id: 'web-dev', label: 'Web Development' },
      { id: 'mobile-dev', label: 'Mobile Development' },
      { id: 'devops', label: 'DevOps & Cloud' },
      { id: 'data-engineering', label: 'Data Engineering' },
    ],
  },
  {
    id: 'design',
    label: '3D, Game Art & Thiết kế sản phẩm số',
    children: [
      { id: 'ui-ux', label: 'UI/UX Design' },
      { id: '3d-art', label: '3D & Game Art' },
      { id: 'product-design', label: 'Product Design' },
    ],
  },
  {
    id: 'business',
    label: 'Bán hàng & Kinh doanh',
    children: [
      { id: 'marketing', label: 'Marketing' },
      { id: 'seo', label: 'SEO' },
      { id: 'sales', label: 'Sales & BD' },
    ],
  },
  {
    id: 'data',
    label: 'Dữ liệu, Nhập liệu & AI Data Ops',
    children: [
      { id: 'data-entry', label: 'Data Entry' },
      { id: 'data-labeling', label: 'Data Labeling' },
      { id: 'data-analytics', label: 'Analytics' },
    ],
  },
  {
    id: 'finance',
    label: 'Kế toán, Thuế & Tài chính',
    children: [
      { id: 'accounting', label: 'Accounting' },
      { id: 'tax', label: 'Tax & Compliance' },
    ],
  },
];

const ALL_FIELD_IDS = WORK_FIELDS.flatMap((g) => g.children.map((c) => c.id));

module.exports = { WORK_FIELDS, ALL_FIELD_IDS };
