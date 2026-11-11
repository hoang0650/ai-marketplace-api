/**
 * Dates read from the gazette excerpts. They do not approve an integration
 * and they do not block an existing account by themselves.
 *
 * ND248/2026 Điều 52(1)–(2): the decree is effective 01/07/2026; electronic
 * identity of domestic sellers and livestream sellers runs from 01/01/2027.
 * ND320/2026 Điều 20(3): effective 28/09/2026. Electronic transaction accounts
 * named in the amended Điều 40(9) — sellers, livestream sellers and affiliates
 * on e-commerce — that existed before that date must be linked by 31/12/2026.
 * Banking accounts in that clause have until 30/06/2027. Điều 18(5) as amended
 * sends an organisation through an authentication-service provider under an
 * approved plan. A manual tax-code review is not that authentication.
 */
function electronicIdentitySchedule() {
  return {
    nd248EffectiveOn: '2026-07-01',
    sellerAndLivestreamElectronicIdentityFrom: '2027-01-01',
    nd320EffectiveOn: '2026-09-28',
    preexistingNamedPlatformAccountsLinkBy: '2026-12-31',
    preexistingBankingAccountsLinkBy: '2027-06-30',
    manualTaxReviewGrantsElectronicIdentity: false,
    manualTaxReviewGrantsAffiliateEligibility: false,
    directCivilDatabaseConnectionAuthorized: false,
  };
}

module.exports = { electronicIdentitySchedule };
