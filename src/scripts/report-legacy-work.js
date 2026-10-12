/**
 * READ-ONLY report of what the discontinued Work board / Hire projects left in the database.
 * Moves no money and writes nothing. Usage: npm run report:legacy-work
 *
 * Money model reminder: there are no separate Work wallets. Every user has one wallet
 * (WalletTx ledger). Work contracts never moved money; Hire projects charged the buyer and
 * credited the seller per approved milestone (48h hold). Unapproved milestones were never charged.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config/env');
const User = require('../models/User');
const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const TalentProfile = require('../models/TalentProfile');
const HireProject = require('../models/HireProject');
const WalletTx = require('../models/WalletTx');
const { getAvailableBalance } = require('../utils/wallet');

async function countBy(Model, field) {
  const rows = await Model.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
}

async function main() {
  await mongoose.connect(config.mongoUri);
  const out = {};
  out.jobPostings = await countBy(JobPosting, 'status');
  out.jobApplications = await countBy(JobApplication, 'status');
  out.jobWorkStatus = await countBy(JobApplication, 'workStatus');
  out.talentProfiles = await TalentProfile.countDocuments();
  out.hireProjects = await countBy(HireProject, 'status');

  const openHire = await HireProject.find({ status: { $in: ['requested', 'quoted', 'active'] } }).lean();
  let approved = 0;
  let unapproved = 0;
  let unapprovedAmount = 0;
  for (const p of openHire) {
    for (const m of p.milestones || []) {
      if (m.status === 'approved') approved += 1;
      else if (m.status !== 'cancelled') {
        unapproved += 1;
        unapprovedAmount += Number(m.amount) || 0;
      }
    }
  }
  out.openHireMilestones = { approved, unapprovedNotCharged: unapproved, unapprovedAmount };

  const listingFees = await WalletTx.aggregate([
    { $match: { 'meta.kind': 'work_listing_fee' } },
    { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  out.workListingFeesPaid = listingFees[0] || { n: 0, amount: 0 };

  const workUsers = await User.find({ role: { $in: ['employer', 'freelancer'] } }).select('_id role').lean();
  const balances = { employer: { users: 0, withBalance: 0, balance: 0, held: 0 }, freelancer: { users: 0, withBalance: 0, balance: 0, held: 0 } };
  for (const u of workUsers) {
    const b = balances[u.role];
    b.users += 1;
    const s = await getAvailableBalance(u._id);
    if (s.balance > 0) {
      b.withBalance += 1;
      b.balance += s.balance;
      b.held += s.held;
    }
  }
  out.workRoleWalletBalancesUSD = balances;

  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
