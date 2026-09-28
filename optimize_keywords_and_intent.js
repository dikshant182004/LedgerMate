// Script to inject High Search Intent and Local Search Keywords across LedgerMate
import fs from 'node:fs';
import path from 'node:path';

// Mapping of specific paths to high-demand keywords and local search terms
const KEYWORDS_MAP = {
  // --- REGIONAL TOOLS & LOCAL NATIVE QUERIES ---
  'public/ar/end-of-service-calculator/index.html': [
    'حساب مكافأة نهاية الخدمة',
    'حاسبة نهاية الخدمة وزارة الموارد البشرية 2026',
    'مكافأة نهاية الخدمة في نظام العمل السعودي',
    'المادة 84 نظام العمل السعودي',
    'المادة 85 استقالة الموظف ونسب الاستحقاق',
    'حساب نهاية الخدمة الامارات قانون العمل الجديد 33 لسنة 2021',
    'مكافأة نهاية الخدمة قطر قانون رقم 14',
    'حساب مستحقات نهاية الخدمة والبدلات وبدل الاجازات',
    'end of service gratuity calculator uae',
    'saudi labor law gratuity calculation',
    'qatar severance pay calculator',
    'gcc gratuity calculator'
  ],
  'public/ar/inheritance-calculator/index.html': [
    'حساب المواريث والتركات',
    'حاسبة التركات الشرعية وزارة العدل',
    'تقسيم الميراث الشرعي إلكترونيا',
    'جدول تقسيم الميراث لأصحاب الفروض والعصبات',
    'نصيب الزوجة من الميراث مع وجود أبناء',
    'حجب الحرمان وحجب النقصان في الميراث',
    'العول والرد في قسمة التركات',
    'حساب ميراث الأب والأم والابن والابنة',
    'شريعة الميراث الإسلامي',
    'islamic inheritance calculator sharia estate law'
  ],
  'public/ar/zakat-calculator/index.html': [
    'حساب زكاة المال',
    'حاسبة الزكاة 2026',
    'نصاب الزكاة بالريال السعودي والدينار',
    'زكاة الذهب عيار 21 عيار 24 عيار 18',
    'زكاة عروض التجارة والأنشطة التجارية',
    'زكاة الأسهم النقية والمضاربة والاستثمارية',
    'كيفية حساب زكاة الأموال المودعة في البنك',
    'هيئة الزكاة والضريبة والجمارك زكاتي',
    'حساب الزكاة على الراتب والمدخرات السنوية',
    'zakat calculator gold silver cash stocks'
  ],
  'public/es/calculadora-aguinaldo/index.html': [
    'calculadora de aguinaldo 2026',
    'calcular aguinaldo mexico ley federal del trabajo',
    'articulo 87 lft aguinaldo 15 dias',
    'como se calcula el aguinaldo proporcional por renuncia',
    'cuanto me toca de aguinaldo con sueldo fijo o variable',
    'fecha limite pago de aguinaldo 20 de diciembre',
    'exencion isr aguinaldo 30 umas sat',
    'calculo de aguinaldo proporcional',
    'mexico christmas bonus calculator',
    'calculadora laboral mexico aguinaldo'
  ],
  'public/es/calculadora-finiquito/index.html': [
    'calculadora de finiquito 2026',
    'calcular liquidacion por despido injustificado',
    'finiquito por renuncia voluntaria calculo',
    'indemnizacion constitucional 3 meses de sueldo lft',
    '20 dias de salario por cada ano trabajado',
    'prima de antiguedad 12 dias por ano tope 2 umas',
    'diferencia entre finiquito y liquidacion',
    'salario diario integrado sdi calculo',
    'calculadora de finiquito espana y mexico',
    'mexico severance and settlement calculator'
  ],
  'public/fr/bareme-kilometrique/index.html': [
    'bareme kilometrique 2026',
    'calculateur bareme kilometrique urssaf impots',
    'simulation frais reels impots gouv fr',
    'deduction frais de deplacement domicile travail',
    'bareme km voiture electrique majoration 20 pourcent',
    'frais kilometriques moto scooter puissance fiscale cv',
    'tableau bareme kilometrique officiel impots 2026',
    'indemnites kilometriques benevolat association',
    'french mileage expense calculator urssaf'
  ],
  'public/fr/calculateur-indemnite-licenciement/index.html': [
    'calculateur indemnite de licenciement 2026',
    'calcul indemnite legale de licenciement code du travail',
    'licenciement motif economique motif personnel',
    'indemnite de rupture conventionnelle cdi',
    'salaire de reference 3 ou 12 derniers mois',
    'indemnite de licenciement faute simple faute grave inaptitude',
    'bareme macron indemnite prudhommes',
    'french severance pay calculator code du travail'
  ],
  'public/regional/index.html': [
    'global statutory financial calculators',
    'regional salary tax payroll calculators 2026',
    'middle east gratuity zakat inheritance calculators',
    'mexico lft finiquito aguinaldo calculadora',
    'french urssaf bareme kilometrique licenciement',
    'germany brutto netto rechner 2026',
    'japan te-dori take home pay calculator',
    'korea salary net pay 4 major insurances',
    'india in-hand ctc salary calculator new regime',
    'us paycheck tax withholding calculator 2026',
    'iban validator bic swift verification tool'
  ],

  // --- REGIONAL SALARY & TAX TOOLS IN PUBLIC/TOOLS ---
  'public/tools/germany-salary-calculator/index.html': [
    'brutto netto rechner 2026',
    'gehaltsrechner deutschland bmf',
    'nettolohn berechnen 2026',
    'steuerklasse 1 2 3 4 5 6 berechnung',
    'sozialversicherungsbeitraege 2026 rentenversicherung krankenkasse',
    'zusatzbeitrag krankenkasse 2026',
    'solidaritaetszuschlag freigrenze',
    'geldwerter vorteil firmenwagen 1 prozent regelung',
    'lohnsteuer berechnen deutschland',
    'german take home salary net pay calculator'
  ],
  'public/tools/india-ctc-salary-calculator/index.html': [
    'in hand salary calculator from ctc',
    'take home salary calculator india 2026',
    'ctc to monthly in hand salary breakdown',
    '12 lpa in hand salary monthly',
    '15 lpa in hand salary new tax regime',
    'epf deduction employee employer 12 percent',
    'standard deduction 75000 new regime budget 2024',
    'professional tax deduction karnataka maharashtra',
    'gratuity calculation in ctc package',
    'india salary calculator new vs old regime'
  ],
  'public/tools/india-income-tax-calculator/index.html': [
    'income tax calculator fy 2025-26 ay 2026-27',
    'new tax regime vs old tax regime calculator',
    'section 115bac tax slab rates 2024 2025 2026',
    'section 87a rebate 7 lakh income zero tax',
    'standard deduction 75000 salary income tax',
    'hra exemption calculation old regime',
    'section 80c 80d deductions calculator',
    'india income tax slab calculator'
  ],
  'public/tools/japan-salary-calculator/index.html': [
    '手取り計算機 2026',
    '年収 手取り 早見表 2026',
    '月収 手取り シミュレーション',
    '額面30万 手取り いくら',
    '給与所得控除 2026',
    '社会保険料 健康保険 厚生年金 雇用保険',
    '子ども子育て支援金 2026 手取り 影響',
    '所得税 住民税 計算式',
    '新社会人 初任給 手取り 計算',
    'ボーナス 手取り 計算機',
    'japan salary take home pay calculator'
  ],
  'public/tools/korea-salary-calculator/index.html': [
    '2026 연봉 실수령액 계산기',
    '월급 실수령액 표 2026',
    '연봉 3000 4000 5000 6000 실수령액',
    '4대보험 계산기 국민연금 건강보험 장기요양 고용보험',
    '근로소득세 간이세액표 계산',
    '비과세 식대 20만원 반영',
    '퇴직금 별도 포함 연봉 계산기',
    '월급 세후 실수령액 계산기',
    'korean salary take home pay calculator'
  ],
  'public/tools/russia-salary-calculator/index.html': [
    'калькулятор зарплаты на руки 2026',
    'расчет ндфл 13 15 18 20 22 процентов',
    'прогрессивная шкала ндфл 2025 2026',
    'зарплата гросс в нетто расчет',
    'страховые взносы пфр фсс омс 30 процентов',
    'стандартный налоговый вычет на детей ндфл',
    'расчет зарплаты и налогов с фонда оплаты труда',
    'russian net salary take home calculator ndfl'
  ],
  'public/tools/us-paycheck-calculator/index.html': [
    'paycheck calculator 2026',
    'take home pay calculator by state',
    'w4 paycheck withholding calculator',
    'federal income tax withholding brackets 2026',
    'fica tax social security medicare deduction',
    'biweekly semi-monthly paycheck calculator',
    'hourly to salary paycheck calculator with overtime',
    'net salary calculator after taxes us'
  ],
  'public/tools/us-tax-calculator/index.html': [
    'us income tax calculator 2026',
    'federal tax brackets 2025 2026 irs',
    'standard deduction married filing jointly single head of household',
    'effective tax rate vs marginal tax rate calculator',
    'taxable income calculation irs form 1040',
    'child tax credit standard deduction 2026',
    'federal income tax estimator'
  ],
  'public/tools/vat-calculator/index.html': [
    'vat calculator add remove vat',
    'reverse vat calculation formula net from gross',
    'uk vat calculator 20 percent standard rate',
    'sales tax calculator and gst calculator',
    'calculate gross price from net price vat',
    'value added tax calculator free online'
  ],
  'public/tools/iban-validator/index.html': [
    'iban validator free online',
    'check iban number format mod 97 checksum',
    'sepa iban validator and bic swift lookup',
    'validate international bank account number',
    'verify european bank iban code'
  ],

  // --- POPULAR FREE EXPENSE & LIVING SPLIT TOOLS ---
  'public/tools/rent-split-calculator/index.html': [
    'rent split calculator by square footage',
    'roommate rent split calculator fair room size',
    'how to split rent with unequal rooms',
    'split rent by square feet and private bathroom',
    '50 50 common area rent split formula',
    'splitwise rent calculator free alternative',
    'fair rent division roommates apartment'
  ],
  'public/tools/bill-split-calculator/index.html': [
    'bill split calculator with tip and tax',
    'split restaurant bill evenly or itemized',
    'tip calculator and bill split per person',
    'split dining check multiple credit cards',
    'restaurant group expense split calculator',
    'splitwise alternative bill splitter'
  ],
  'public/tools/couple-roommate-rent-calculator/index.html': [
    'couple roommate rent split calculator',
    'how to split rent with a couple and a single roommate',
    'split rent fairly couple sharing master bedroom',
    'rent split 2 bedroom 1 couple 1 single',
    'couple roommate square footage utility split'
  ],
  'public/tools/proportional-split-calculator/index.html': [
    'proportional split calculator by income',
    'income based rent split calculator',
    'how to split expenses proportionally based on salary',
    'equitable expense splitting couples unequal income',
    'percentage income bill split calculator'
  ],
  'public/tools/prorated-rent-calculator/index.html': [
    'prorated rent calculator',
    'how to prorate rent moving in middle of month',
    'daily rent rate calculator 30 day 31 day month',
    'prorated rent formula move in move out',
    'partial month rent calculation for tenants landlords'
  ],
  'public/tools/rent-affordability-calculator/index.html': [
    'rent affordability calculator',
    'how much rent can i afford calculator',
    '30 percent rule rent calculator monthly salary',
    '40x income rule rent calculator nyc',
    'rent to income ratio calculator'
  ],
  'public/tools/rent-vs-buy-calculator/index.html': [
    'rent vs buy calculator',
    'is it better to rent or buy a home calculator',
    'rent vs buy break even horizon analysis',
    'homeownership costs vs renting opportunity cost',
    'housing affordability rent or purchase'
  ],
  'public/tools/gas-split-calculator/index.html': [
    'gas split calculator road trip',
    'split gas money calculator per person',
    'fuel expense calculator by mpg distance gas price',
    'road trip gas and toll split calculator',
    'carpool gas cost calculator'
  ],
  'public/tools/trip-budget-calculator/index.html': [
    'trip budget calculator',
    'vacation budget planner per person',
    'group travel expense estimator flights hotel meals',
    'holiday trip budget calculator free'
  ],
  'public/tools/trip-expense-calculator/index.html': [
    'trip expense calculator group travel',
    'split vacation expenses with friends',
    'who owes what trip cost settlement calculator',
    'group vacation bill splitter'
  ],
  'public/tools/airbnb-room-split-calculator/index.html': [
    'airbnb room split calculator',
    'split vacation rental unequal rooms and beds',
    'fair airbnb house cost split per person bedroom',
    'vrbo cabin rental split master vs bunk bed'
  ],
  'public/tools/multi-currency-split-calculator/index.html': [
    'multi currency split calculator',
    'split expenses in foreign currencies exchange rates',
    'international travel bill split multi currency',
    'fx converted group expense settlement'
  ],
  'public/tools/wedding-budget-calculator/index.html': [
    'wedding budget calculator',
    'wedding cost breakdown estimator by category',
    'average wedding budget per guest venue catering',
    'wedding expense tracker calculator'
  ],
  'public/tools/bachelorette-expense-calculator/index.html': [
    'bachelorette party expense calculator',
    'split bachelorette party costs cover the bride',
    'bachelorette weekend budget per person',
    'hen party budget split calculator'
  ],

  // --- LOAN, MORTGAGE & FINANCE TOOLS ---
  'public/tools/car-loan-calculator/index.html': [
    'car loan calculator with trade in and sales tax',
    'auto loan payment calculator monthly principal interest',
    'car financing calculator loan term interest rate',
    'car loan amortization schedule table',
    'how much car loan can i afford calculator'
  ],
  'public/tools/mortgage-calculator/index.html': [
    'mortgage payment calculator with pmi and taxes',
    'home loan monthly payment calculator principal interest',
    '30 year fixed mortgage payment calculator',
    'mortgage amortization schedule with extra payments',
    'how much house can i afford mortgage calculator'
  ],
  'public/tools/compound-interest-calculator/index.html': [
    'compound interest calculator with monthly contributions',
    'daily monthly annual compound interest formula',
    'investment growth calculator compound interest',
    'rule of 72 compound interest calculator',
    'future value compound interest savings calculator'
  ],
  'public/tools/loan-emi-calculator/index.html': [
    'loan emi calculator online free',
    'home loan personal loan car loan emi calculation',
    'reducing balance emi formula calculator',
    'monthly loan installment repayment schedule'
  ],
  'public/tools/student-loan-calculator/index.html': [
    'student loan repayment calculator',
    'student loan payoff calculator extra payments',
    'student loan interest calculation save plan',
    'college loan amortization schedule calculator'
  ],
  'public/tools/retirement-calculator/index.html': [
    'retirement savings calculator nest egg',
    '401k retirement calculator contribution match',
    'fire calculator financial independence retire early',
    '4 percent rule retirement withdrawal calculator',
    'how much money do i need to retire calculator'
  ],
  'public/tools/freelance-rate-calculator/index.html': [
    'freelance hourly rate calculator',
    'convert salary to freelance rate',
    'consultant day rate calculator billable hours',
    'freelancer pricing calculator with taxes and overhead'
  ],
  'public/tools/discount-calculator/index.html': [
    'discount calculator percent off sale price',
    'double discount calculator stacked coupon',
    'how to calculate discount percentage',
    'sale price calculator with sales tax'
  ],

  // --- HEALTH & FITNESS CALCULATORS ---
  'public/tools/bmr-calculator/index.html': [
    'bmr calculator basal metabolic rate',
    'mifflin st jeor bmr formula calculator',
    'calories burned at rest calculator',
    'calculate bmr for men and women'
  ],
  'public/tools/tdee-calculator/index.html': [
    'tdee calculator total daily energy expenditure',
    'maintenance calories calculator cutting bulking',
    'tdee macro calculator for fat loss',
    'daily calorie burn calculator activity level'
  ],
  'public/tools/body-fat-calculator/index.html': [
    'body fat calculator us navy method',
    'body fat percentage calculator tape measure',
    'lean body mass calculator navy formula',
    'calculate body fat percentage without calipers'
  ],
  'public/tools/macro-calculator/index.html': [
    'macro calculator for weight loss muscle gain',
    'macronutrient ratio calculator protein carb fat',
    'iifym macro calculator daily grams',
    'keto macro calculator bodybuilding'
  ],
  'public/tools/ovulation-calculator/index.html': [
    'ovulation calculator fertile window',
    'fertile days calculator conception',
    'period cycle ovulation predictor',
    'most fertile days to get pregnant calculator'
  ],
  'public/tools/pregnancy-due-date-calculator/index.html': [
    'pregnancy due date calculator',
    'due date calculator by conception date lmp',
    'how many weeks pregnant am i calculator',
    'estimated date of delivery edd calculator'
  ],

  // --- GENERAL MATH, CONVERSION & UTILITY TOOLS ---
  'public/tools/percentage-calculator/index.html': [
    'percentage calculator online free',
    'what percent of x is y calculator',
    'percentage increase decrease calculator',
    'percentage difference formula calculator'
  ],
  'public/tools/age-calculator/index.html': [
    'age calculator date of birth',
    'chronological age calculator years months days',
    'exact age calculator in days hours minutes',
    'how old am i calculator'
  ],
  'public/tools/aspect-ratio-calculator/index.html': [
    'aspect ratio calculator 16 9 4 3 21 9',
    'image resolution resize calculator',
    'video aspect ratio dimensions calculator',
    'calculate width height aspect ratio'
  ],
  'public/tools/download-time-calculator/index.html': [
    'download time calculator file size speed',
    'how long will download take calculator',
    'internet bandwidth download speed estimator',
    'gigabit fiber mbps to download time'
  ],
  'public/tools/electricity-cost-calculator/index.html': [
    'electricity cost calculator appliance kwh',
    'electric bill power consumption calculator',
    'calculate cost to run ac heater pc refrigerator',
    'watt to kwh electricity price calculator'
  ],
  'public/tools/gpa-calculator/index.html': [
    'gpa calculator 4.0 scale',
    'college gpa calculator weighted unweighted',
    'cumulative semester gpa grade calculator',
    'high school gpa conversion calculator'
  ],
  'public/tools/px-to-rem-converter/index.html': [
    'px to rem converter 16px base',
    'pixel to rem conversion table css',
    'rem to px calculator responsive web design',
    'tailwind px rem converter'
  ],
  'public/tools/scientific-calculator/index.html': [
    'scientific calculator online free',
    'advanced math calculator sin cos tan log',
    'browser scientific calculator with radians degrees',
    'trigonometry scientific calculator'
  ],
  'public/tools/time-zone-converter/index.html': [
    'time zone converter world clock meeting planner',
    'convert est to pst gmt ist utc time difference',
    'international time zone meeting coordinator',
    'world time difference calculator'
  ],
  'public/tools/unit-converter/index.html': [
    'unit converter online metric imperial',
    'convert kg to lbs celsius to fahrenheit cm to inches',
    'length weight temperature volume unit converter',
    'measurement conversion calculator'
  ],
  'public/tools/cloud-cost-calculator/index.html': [
    'cloud cost calculator aws gcp azure',
    'cloud server hosting cost estimator vm ram',
    'monthly cloud infrastructure budget calculator',
    'cloud pricing comparison calculator'
  ],
  'public/tools/dog-cost-calculator/index.html': [
    'dog cost calculator puppy first year expenses',
    'lifetime cost of owning a dog calculator',
    'monthly dog food vet grooming insurance budget',
    'how much does a dog cost calculator'
  ],
  'public/tools/calc-agent/index.html': [
    'ai financial calculator natural language',
    'ai expense split calculation agent',
    'conversational math solver financial assistant',
    'LedgerMate ai calculation agent'
  ],

  // --- CORE PAGES & HUBS ---
  'public/index.html': [
    'splitwise alternative free',
    'free expense splitting app no ads no limits',
    'bill splitting app roommates couples friends',
    'split rent fairly square footage calculator',
    'group travel expense tracker',
    'real time shared ledger sync',
    'unlimited free expense sharing Ledgermate'
  ],
  'public/compare/splitwise-alternative/index.html': [
    'best splitwise alternatives 2026',
    'splitwise 3 expense limit workaround',
    'splitwise alternative free no ads no subscription',
    'free group expense sharing without pro paywall',
    'splitwise vs ledgermate comparison'
  ],
  'public/about/index.html': [
    'about ledgermate mission editorial methodology',
    'free financial calculator research team',
    'expense splitting platform architecture',
    'privacy first financial tools'
  ],
  'public/feedback/index.html': [
    'ledgermate product feedback and support',
    'request a new calculator tool',
    'report calculation formula bug',
    'customer support ledgermate'
  ],
  'public/privacy/index.html': [
    'ledgermate privacy policy zero tracker guarantee',
    'local first data storage expense privacy',
    'gdpr ccpa financial calculator privacy'
  ],
  'public/terms/index.html': [
    'ledgermate terms of service',
    'financial calculator disclaimer and usage terms',
    'free software terms ledgermate'
  ]
};

let updatedCount = 0;

for (const [relPath, keywordsList] of Object.entries(KEYWORDS_MAP)) {
  const filePath = path.resolve(relPath);
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
    continue;
  }

  let html = fs.readFileSync(filePath, 'utf8');
  const kwContent = keywordsList.join(', ');

  // Check if <meta name="keywords"> already exists
  if (/<meta\s+name=["']keywords["']/i.test(html)) {
    html = html.replace(
      /<meta\s+name=["']keywords["'][^>]*>/i,
      `<meta name="keywords" content="${kwContent}" />`
    );
  } else {
    // Insert right after meta description or right after <head>
    if (/<meta\s+name=["']description["'][^>]*>/i.test(html)) {
      html = html.replace(
        /(<meta\s+name=["']description["'][^>]*>)/i,
        `$1\n<meta name="keywords" content="${kwContent}" />`
      );
    } else if (/<head[^>]*>/i.test(html)) {
      html = html.replace(
        /(<head[^>]*>)/i,
        `$1\n<meta name="keywords" content="${kwContent}" />`
      );
    }
  }

  fs.writeFileSync(filePath, html, 'utf8');
  updatedCount++;
}

console.log(`Successfully injected/updated high-demand keywords into ${updatedCount} files.`);
