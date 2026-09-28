import fs from 'node:fs';
import path from 'node:path';

const EXTRA_MAP = {
  'public/app/index.html': [
    'free expense splitting web app',
    'split bills with roommates',
    'splitwise alternative app no ads',
    'track group expenses offline pwa',
    'share bills with friends online'
  ],
  'public/blog/best-splitwise-alternatives/index.html': [
    'best splitwise alternatives 2026',
    'free bill splitting app without daily limits',
    'splitwise alternatives reddit',
    'free group expense tracker'
  ],
  'public/blog/fair-rent-split-unequal-rooms/index.html': [
    'how to split rent with unequal rooms',
    'fair rent split square footage',
    'room size rent division formula',
    'master bedroom private bath rent split'
  ],
  'public/blog/how-couples-split-expenses/index.html': [
    'how couples split expenses fairly',
    'proportional expense splitting by income',
    'joint vs separate accounts couples',
    '50 50 vs proportional splitting'
  ],
  'public/blog/how-to-calculate-prorated-rent/index.html': [
    'how to calculate prorated rent',
    'prorate rent mid month formula',
    'daily rent calculation',
    'tenant landlord prorated rent guide'
  ],
  'public/blog/how-to-split-trip-expenses/index.html': [
    'how to split trip expenses with friends',
    'group travel expense tracker',
    'split vacation bills multi currency',
    'who owes what travel app'
  ],
  'public/blog/splitwise-free-limit-alternatives/index.html': [
    'splitwise free limit workaround',
    'splitwise 3 expense limit bypass',
    'free alternative to splitwise',
    'splitwise premium cost vs free alternatives'
  ],
  'public/guides/30-percent-rent-rule/index.html': [
    '30 percent rent rule explained',
    'how much should i spend on rent',
    '30 percent gross vs net income rent',
    'affordable rent guide'
  ],
  'public/guides/calc-agent/index.html': [
    'ai calculation agent user guide',
    'how to use natural language financial calculator',
    'ledgermate ai agent tips'
  ],
  'public/guides/ctc-vs-in-hand-salary-structure/index.html': [
    'ctc vs in hand salary structure india',
    'difference between gross ctc and net salary',
    'components of ctc pf gratuity allowance'
  ],
  'public/guides/german-salary-tax-classes-guide/index.html': [
    'german salary tax classes explained',
    'steuerklasse 1 bis 6 lohnsteuer',
    'which tax class in germany married singles'
  ],
  'public/guides/home-loan-prepayment-rules/index.html': [
    'home loan prepayment rules and penalty',
    'should you prepay home loan or invest',
    'reduce emi vs loan tenure'
  ],
  'public/guides/marginal-vs-effective-tax-rate/index.html': [
    'marginal vs effective tax rate difference',
    'how tax brackets work',
    'blended average tax rate calculation'
  ],
  'public/guides/mortgage-interest-and-amortization/index.html': [
    'how mortgage interest and amortization works',
    'front loaded interest mortgage',
    'principal vs interest payment breakdown'
  ],
  'public/guides/prorated-rent-calculation-methods/index.html': [
    'prorated rent calculation methods 30 day 31 day',
    'actual days in month vs banker rule rent prorate'
  ],
  'public/guides/utility-and-rent-decoupling/index.html': [
    'why utilities should be decoupled from rent',
    'splitting electric gas wifi equally vs rent by room size'
  ],
  'public/guides/what-is-a-401k-how-it-works/index.html': [
    'what is a 401k and how it works',
    '401k contribution limits employer match',
    'traditional vs roth 401k'
  ],
  'public/security/calc-agent/index.html': [
    'ai calculator security and data privacy',
    'stateless mathematical computation',
    'zero prompt retention financial ai'
  ]
};

for (const [relPath, list] of Object.entries(EXTRA_MAP)) {
  const full = path.resolve(relPath);
  if (!fs.existsSync(full)) continue;
  let html = fs.readFileSync(full, 'utf8');
  const kw = list.join(', ');
  if (/<meta\s+name=["']description["'][^>]*>/i.test(html)) {
    html = html.replace(/(<meta\s+name=["']description["'][^>]*>)/i, `$1\n<meta name="keywords" content="${kw}" />`);
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1\n<meta name="keywords" content="${kw}" />`);
  }
  fs.writeFileSync(full, html, 'utf8');
}
console.log('Injected remaining 18 files keywords.');
