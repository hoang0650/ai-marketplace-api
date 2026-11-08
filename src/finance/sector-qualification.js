/** Categories kept on sale. Sector licences are not claimed. */
const DRAFT_SECTORS = {
  'ai-film-series': 'film',
  'story-book': 'publication',
  'voice-clone': 'cloned_voice',
  'voice-preset': 'cloned_voice',
  'gpu-compute': 'cloud',
};

function sectorQualification(category) {
  const sector = DRAFT_SECTORS[String(category || '')] || null;
  if (!sector) {
    return { status: 'not_applicable', sector: null, qualified: false, evidenceRequired: false };
  }
  return { status: 'draft_unverified', sector, qualified: false, evidenceRequired: true };
}

module.exports = { DRAFT_SECTORS, sectorQualification };
