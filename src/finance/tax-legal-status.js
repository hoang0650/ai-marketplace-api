/**
 * What the stored rates are not. Amounts already configured stay in the tax
 * modules. This object does not replace them and it is not an accountant sign-off.
 *
 * ND252/2026 Điều 43(1) covers both household businesses and business individuals
 * on a platform with online ordering and payment. Điều 44(1)(b) times withholding
 * at successful confirmation and payment acceptance. Điều 44(2) uses the statutory
 * percentage for the goods or service, and the highest applicable percentage when
 * the kind cannot be told from data already held. Điều 45(2) says the platform
 * files withheld tax monthly. None of those sentences supply the 7%, 1.5%, 0%
 * household, or 100,000,000 VND figures stored in config.
 *
 * ND253/2026 Điều 50(2) is the 10% withholding, from 5,000,000 VND per payment,
 * for resident individuals paid wages, remuneration or other income with no
 * contract or a labour contract under three months. Below that line, 10% applies
 * only when the individual asks. A commitment is a temporary reason not to
 * withhold for that person, not an automatic exemption, and not a rule for every
 * affiliate. The current form name after 01/07/2026 was not verified here.
 */
function taxLegalStatus() {
  return {
    determination: 'unresolved',
    configuredAmountsPreserved: true,
    statutoryRateTableApplied: false,
    householdZeroIsConfiguredNotStatutoryBlanket: true,
    annualThresholdIsConfiguredNotStatutoryFinding: true,
    affiliateArticle50Paragraph2IsNotUniversal: true,
    fiveMillionPerPaymentNotApplied: true,
    commitmentIsNotAutomaticExemption: true,
    withholdingMomentCited: 'successful_transaction_and_payment_acceptance',
    platformFilingCadenceCited: 'monthly',
    filingCadenceImplemented: false,
    accountantInputsRequired: [
      'seller class: business individual, household business, company, or foreign supplier',
      'residency of the payee',
      'whether that transaction uses online ordering and payment on the platform',
      'goods, service, or unclassified on data the platform already holds',
      'who pays the affiliate and whether the payment is the Điều 50(2) remuneration class',
      'per-payment amount, and whether the individual asked to be withheld below the line for that class',
      'a commitment under the form required by current tax administration, and its year',
      'effective date of a matrix the accountant has approved',
    ],
  };
}

/** A new caller may not install a statutory rate without that matrix. Configured math is untouched. */
function rejectUngroundedStatutoryOverride(input = {}) {
  if (input.statutoryRate != null && input.accountantApprovedMatrix !== true) {
    return {
      ok: false,
      code: 'TAX_MATRIX_REQUIRED',
      message: 'A new statutory rate needs an accountant-approved classification matrix. Configured amounts are unchanged.',
    };
  }
  return { ok: true, code: null };
}

module.exports = { taxLegalStatus, rejectUngroundedStatutoryOverride };
