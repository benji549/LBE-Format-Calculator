export function makeNumber(value, min = 0, max = Math.max(Number(value) * 2, 100), step = 1) {
  return { value, min, max, step, useSlider: false };
}

export function createDefaultFormat(index = 1) {
  return {
    schemaVersion: 1,
    name: `LBE Format ${index}`,
    description: '',
    visibility: 'team',
    currency: 'USD',
    area: makeNumber(500, 50, 3000, 10),
    thrc: makeNumber(120, 10, 600, 5),
    ticketPrice: makeNumber(35, 5, 100, 1),
    operatingHours: makeNumber(10, 1, 18, 0.5),
    daysPerWeek: makeNumber(6, 1, 7, 0.5),
    utilization: makeNumber(45, 5, 100, 1),
    rentAmount: makeNumber(50, 10, 250, 1),
    rentMode: 'perM2',
    rentBilling: 'annual',
    headsetCount: makeNumber(30, 0, 150, 1),
    headsetPrice: makeNumber(700, 0, 5000, 50),
    startupOther: makeNumber(150000, 0, 1000000, 5000),
    year2RevenueGrowth: makeNumber(5, -50, 100, 1),
    year2ExpenseInflation: makeNumber(3, -20, 50, 0.5),
    expenses: [
      createExpense('Staff and operations', 20000, true, 'monthly'),
      createExpense('Fit-out and installation', 250000, false, 'annual'),
    ],
  };
}

export function createExpense(name = 'New expense', value = 0, recurring = true, cadence = 'monthly') {
  return {
    id: crypto.randomUUID(),
    name,
    amount: makeNumber(value, 0, Math.max(Number(value) * 2, 100000), 1000),
    recurring,
    cadence,
  };
}

export function normalizeFormat(input = {}) {
  const base = createDefaultFormat();
  const merged = { ...base, ...structuredClone(input) };
  const numberKeys = [
    'area', 'thrc', 'ticketPrice', 'operatingHours', 'daysPerWeek', 'utilization',
    'rentAmount', 'headsetCount', 'headsetPrice', 'startupOther',
    'year2RevenueGrowth', 'year2ExpenseInflation',
  ];

  for (const key of numberKeys) {
    merged[key] = { ...base[key], ...(input[key] || {}) };
  }

  merged.expenses = Array.isArray(input.expenses)
    ? input.expenses.map((expense) => ({
        ...createExpense(),
        ...expense,
        id: expense.id || crypto.randomUUID(),
        amount: { ...makeNumber(0, 0, 100000, 1000), ...(expense.amount || {}) },
      }))
    : base.expenses;

  return merged;
}

function annualizedExpense(expense) {
  const amount = Number(expense.amount?.value) || 0;
  if (!expense.recurring) return { year1: amount, year2Base: 0 };
  const annual = expense.cadence === 'monthly' ? amount * 12 : amount;
  return { year1: annual, year2Base: annual };
}

export function calculate(format) {
  const s = normalizeFormat(format);
  const v = (key) => Number(s[key]?.value) || 0;
  const area = v('area');
  const annualCapacity = v('thrc') * v('operatingHours') * v('daysPerWeek') * 52;
  const attendance1 = annualCapacity * (v('utilization') / 100);
  const revenue1 = attendance1 * v('ticketPrice');
  const revenue2 = revenue1 * (1 + v('year2RevenueGrowth') / 100);

  let rent1 = v('rentAmount');
  if (s.rentMode === 'perM2') rent1 *= area;
  if (s.rentBilling === 'monthly') rent1 *= 12;

  const inflationFactor = 1 + v('year2ExpenseInflation') / 100;
  const rent2 = rent1 * inflationFactor;
  const headsetCapex = v('headsetCount') * v('headsetPrice');
  const startup = v('startupOther');

  let otherYear1 = 0;
  let recurringBaseYear2 = 0;
  for (const expense of s.expenses) {
    const annualized = annualizedExpense(expense);
    otherYear1 += annualized.year1;
    recurringBaseYear2 += annualized.year2Base;
  }

  const expenses1 = rent1 + headsetCapex + startup + otherYear1;
  const expenses2 = rent2 + recurringBaseYear2 * inflationFactor;
  const profit1 = revenue1 - expenses1;
  const profit2 = revenue2 - expenses2;
  const profitPerM21 = area > 0 ? profit1 / area : 0;
  const profitPerM22 = area > 0 ? profit2 / area : 0;
  const margin1 = revenue1 > 0 ? (profit1 / revenue1) * 100 : 0;
  const margin2 = revenue2 > 0 ? (profit2 / revenue2) * 100 : 0;
  const revenuePerM2 = area > 0 ? revenue1 / area : 0;
  const breakEvenAttendance1 = v('ticketPrice') > 0 ? expenses1 / v('ticketPrice') : 0;
  const theoreticalRevenueAt100 = annualCapacity * v('ticketPrice');
  const breakEvenUtilization1 = theoreticalRevenueAt100 > 0
    ? (expenses1 / theoreticalRevenueAt100) * 100
    : 0;

  return {
    area,
    annualCapacity,
    attendance1,
    revenue1,
    revenue2,
    rent1,
    rent2,
    headsetCapex,
    startup,
    otherYear1,
    expenses1,
    expenses2,
    profit1,
    profit2,
    profitPerM21,
    profitPerM22,
    margin1,
    margin2,
    revenuePerM2,
    breakEvenAttendance1,
    breakEvenUtilization1,
  };
}

export function formatMoney(value, currency = 'USD') {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(safe);
  } catch {
    return `${currency} ${Math.round(safe).toLocaleString('en-US')}`;
  }
}

export function formatNumber(value, digits = 0) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return safe.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function cloneAsNew(format) {
  const copy = normalizeFormat(structuredClone(format));
  copy.name = `${copy.name} copy`;
  copy.expenses = copy.expenses.map((expense) => ({ ...expense, id: crypto.randomUUID() }));
  return copy;
}
