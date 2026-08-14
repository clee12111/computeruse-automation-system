// mock-console/data.js — Synthetic member data, audit log, data helpers.
// Zero imports from ../src. Exports for server.js.

const CREDENTIALS = {
  operator:   { password: 'demo123', role: 'operator' },
  supervisor: { password: 'demo456', role: 'supervisor' },
};

const SUB_ACCOUNT_TYPES = {
  'holiday-club': 'Holiday Club',
  'money-market': 'Money Market',
  'secondary-savings': 'Secondary Savings',
};

// ── Transaction generator ───────────────────────────────────
const TX_POOL = {
  Savings: [
    ['Payroll Direct Deposit','c',2150],['ATM Withdrawal','d',200],['Interest Payment','c',15],
    ['Mobile Deposit','c',450],['Transfer Out','d',300],['Dividend Credit','c',8],
    ['Wire Transfer In','c',1500],['Counter Withdrawal','d',500],['ACH Credit','c',875],
    ['Automatic Transfer','d',250],
  ],
  Checking: [
    ['Debit Card - Grocery Mart','d',67],['Online Bill Pay - Electric Co','d',125],
    ['ACH Deposit - Employer','c',2400],['POS Purchase - Gas Station','d',48],
    ['Debit Card - Restaurant','d',35],['Online Bill Pay - Internet','d',75],
    ['Mobile Deposit','c',200],['ATM Withdrawal','d',100],['Check #1050','d',250],
    ['Direct Deposit','c',1800],
  ],
  'Money Market': [
    ['Interest Payment','c',125],['Transfer In','c',2000],['Transfer Out','d',1000],
    ['Dividend Credit','c',95],['Wire Transfer In','c',5000],
  ],
  CD: [['Interest Accrual','c',45],['Dividend Credit','c',42]],
};

function genTxs(type, count, seed) {
  const pool = TX_POOL[type] || TX_POOL['Savings'];
  return Array.from({ length: count }, (_, i) => {
    const [desc, dir, base] = pool[(i + seed) % pool.length];
    const amt = Math.max(Math.round((base + ((i * 31 + seed * 17) % 200) - 30) * 100) / 100, 5);
    const mo = 1 + Math.floor(i * 6 / count);
    const dy = 1 + ((i * 7 + seed) % 28);
    return {
      date: `${String(mo).padStart(2,'0')}/${String(dy).padStart(2,'0')}/2026`,
      desc, debit: dir === 'd' ? amt : null, credit: dir === 'c' ? amt : null,
    };
  });
}

function mkAcct(type, number, shareId, balance, opened, txs, opts) {
  const o = opts || {};
  return {
    type, number, shareId, balance,
    available: o.available !== undefined ? o.available : balance,
    dividendRate: o.dividendRate || (type === 'Checking' ? 0.01 : type === 'Money Market' ? 1.75 : type === 'CD' ? 3.85 : 0.45),
    opened, status: o.status || 'Active',
    stopPayments: o.stopPayments || [],
    transactions: txs || genTxs(type, 20, parseInt(number.replace(/\D/g, ''), 10) % 97),
  };
}

// ── Member helper ───────────────────────────────────────────
function mkMember(name, dob, phone, email, memberSince, ssnLast4, addr, codeWord, opts) {
  const o = opts || {};
  return {
    name, dob, phone, email, memberSince, ssnLast4,
    address: addr, alert: o.alert || null, codeWord,
    jointWith: o.jointWith || null,
    secondaryNames: o.secondaryNames || [],
    loanApplications: o.loanApplications || [],
    accounts: o.accounts || [],
    loans: o.loans || [],
    notes: o.notes || [],
  };
}

// ── Synthetic member data ───────────────────────────────────
const MEMBERS = {
  '12345': {
    name: 'Jane Thompson', dob: '03/15/1985', phone: '(503) 555-0142',
    email: 'j.thompson@email.com', memberSince: '03/15/2018', ssnLast4: '4823',
    address: { street: '1247 Oak St', city: 'Portland', state: 'OR', zip: '97205' },
    alert: null, codeWord: 'cascade',
    jointWith: { name: 'Sarah Mitchell', memberId: '11111' },
    secondaryNames: [{ name: 'Sarah Mitchell', relationship: 'Joint Owner', dob: '06/12/1983' }],
    loanApplications: [],
    accounts: [
      mkAcct('Savings', '12345-S1', '00', 4320.10, '03/15/2018', [
        { date: '08/10/2026', desc: 'Interest Payment', debit: null, credit: 20.10 },
        { date: '08/05/2026', desc: 'Transfer to Checking', debit: 800.00, credit: null },
        { date: '08/01/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 2150.00 },
        { date: '07/22/2026', desc: 'ATM Withdrawal', debit: 200.00, credit: null },
        { date: '07/15/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 2150.00 },
        { date: '07/01/2026', desc: 'Opening Deposit', debit: null, credit: 1000.00 },
        ...genTxs('Savings', 14, 0),
      ]),
      mkAcct('Checking', '12345-C1', '01', 1205.63, '03/15/2018', [
        { date: '08/08/2026', desc: 'Debit Card - Gas Station', debit: 52.40, credit: null },
        { date: '08/05/2026', desc: 'Transfer from Savings', debit: null, credit: 800.00 },
        { date: '08/01/2026', desc: 'Check #1042', debit: 250.00, credit: null },
        { date: '07/25/2026', desc: 'Online Bill Pay - City Water', debit: 84.50, credit: null },
        { date: '07/18/2026', desc: 'Debit Card - Corner Market', debit: 32.47, credit: null },
        { date: '07/01/2026', desc: 'Opening Deposit', debit: null, credit: 500.00 },
        ...genTxs('Checking', 14, 1),
      ], { stopPayments: [{ checkNum: '1055', reason: 'Lost in mail', date: '08/05/2026', status: 'Active' }] }),
    ],
    loans: [],
    notes: [{ timestamp: '08/01/2026 09:15', operator: 'operator', type: 'Comment', text: 'Called about savings rate. Directed to current rate sheet.' }],
  },

  '23456': mkMember('Robert Chen', '11/02/1978', '(503) 555-0198', 'r.chen@email.com',
    '06/10/2020', '7291', { street: '3054 Elm Blvd', city: 'Portland', state: 'OR', zip: '97211' }, 'mountain',
    { alert: 'Address verification pending',
      accounts: [
        mkAcct('Savings', '23456-S1', '00', 8150.00, '06/10/2020', [
          { date: '08/01/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 3200.00 },
          { date: '07/10/2026', desc: 'Opening Deposit', debit: null, credit: 5000.00 },
          ...genTxs('Savings', 16, 10),
        ]),
        mkAcct('Checking', '23456-C1', '01', 950.22, '06/10/2020', [
          { date: '07/10/2026', desc: 'Opening Deposit', debit: null, credit: 1000.00 },
          ...genTxs('Checking', 15, 11),
        ]),
        mkAcct('Savings', '23456-S2', '02', 2340.55, '01/05/2022', [
          { date: '07/15/2026', desc: 'Opening Deposit', debit: null, credit: 2500.00 },
          ...genTxs('Savings', 12, 12),
        ]),
      ],
    }),

  '34567': mkMember('Maria Garcia', '07/22/1990', '(503) 555-0234', 'm.garcia@email.com',
    '11/03/2016', '5508', { street: '782 Cedar Ln', city: 'Beaverton', state: 'OR', zip: '97005' }, 'river',
    { accounts: [
        mkAcct('Checking', '34567-C1', '01', 3100.00, '11/03/2016', [
          { date: '08/02/2026', desc: 'Debit Card - Pharmacy', debit: 45.00, credit: null },
          { date: '07/05/2026', desc: 'Opening Deposit', debit: null, credit: 3500.00 },
          ...genTxs('Checking', 18, 20),
        ]),
        mkAcct('Money Market', '34567-M1', '10', 15000.00, '03/20/2019', [
          { date: '06/01/2026', desc: 'Opening Deposit', debit: null, credit: 15000.00 },
          ...genTxs('Money Market', 10, 21),
        ]),
        mkAcct('Savings', '34567-S1', '00', 500.75, '11/03/2016', [
          { date: '07/05/2026', desc: 'Opening Deposit', debit: null, credit: 500.75 },
          ...genTxs('Savings', 12, 22),
        ]),
        mkAcct('CD', '34567-D1', '20', 10000.00, '01/15/2026', [
          { date: '01/15/2026', desc: '12-Month CD Opening', debit: null, credit: 10000.00 },
          ...genTxs('CD', 6, 23),
        ], { available: 0 }),
      ],
      loans: [
        { loanId: 'L-34567-01', type: 'Auto Loan', balance: 9800.00, rate: 4.50,
          nextPaymentDue: '09/10/2026', monthlyPayment: 285.00, opened: '08/01/2024', status: 'Active',
          payments: [
            { date: '06/10/2026', amount: 285.00, ref: 'LP-4010' },
            { date: '07/10/2026', amount: 285.00, ref: 'LP-4011' },
            { date: '08/10/2026', amount: 285.00, ref: 'LP-4012' },
          ] },
      ],
    }),

  '45678': mkMember('David Park', '01/30/1965', '(503) 555-0301', 'd.park@email.com',
    '07/20/2023', '6134', { street: '415 Birch Dr', city: 'Lake Oswego', state: 'OR', zip: '97034' }, 'summit',
    { accounts: [
        mkAcct('Savings', '45678-S1', '00', 200.00, '07/20/2023', [
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 200.00 },
          ...genTxs('Savings', 15, 30),
        ]),
      ],
    }),

  '56789': mkMember('Lisa Williams', '09/14/1992', '(503) 555-0456', 'l.williams@email.com',
    '02/12/2017', '8847', { street: '1920 Spruce Way', city: 'Tigard', state: 'OR', zip: '97223' }, 'valley',
    { jointWith: { name: 'William Davis', memberId: '88888' },
      secondaryNames: [{ name: 'William Davis', relationship: 'Joint Owner', dob: '07/19/1991' }],
      accounts: [
        mkAcct('Checking', '56789-C1', '01', 6543.21, '02/12/2017', [
          { date: '07/30/2026', desc: 'Online Bill Pay - Rent', debit: 456.79, credit: null },
          { date: '06/20/2026', desc: 'Opening Deposit', debit: null, credit: 7000.00 },
          ...genTxs('Checking', 18, 40),
        ]),
        mkAcct('Savings', '56789-S1', '00', 12100.00, '02/12/2017', [
          { date: '08/01/2026', desc: 'Interest Payment', debit: null, credit: 100.00 },
          { date: '06/20/2026', desc: 'Opening Deposit', debit: null, credit: 12000.00 },
          ...genTxs('Savings', 16, 41),
        ]),
      ],
    }),

  '67890': mkMember('James Brown', '05/08/1970', '(503) 555-0567', 'j.brown@email.com',
    '09/05/2021', '2270', { street: '608 Walnut St', city: 'Portland', state: 'OR', zip: '97214' }, 'bridge',
    { accounts: [
        mkAcct('Savings', '67890-S1', '00', 0.50, '09/05/2021', [
          { date: '08/10/2026', desc: 'ATM Withdrawal', debit: 99.50, credit: null },
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 100.00 },
          ...genTxs('Savings', 10, 50),
        ]),
        mkAcct('Checking', '67890-C1', '01', 25.00, '09/05/2021', [
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 25.00 },
          ...genTxs('Checking', 10, 51),
        ]),
      ],
      // Delinquent loan — 43 days past due
      loans: [
        { loanId: 'L-67890-01', type: 'Personal Loan', balance: 2100.00, rate: 8.50,
          nextPaymentDue: '07/01/2026', monthlyPayment: 150.00, opened: '01/15/2025', status: 'Active',
          payments: [
            { date: '05/01/2026', amount: 150.00, ref: 'LP-4060' },
            { date: '06/01/2026', amount: 150.00, ref: 'LP-4061' },
          ] },
      ],
    }),

  '78901': mkMember('Patricia Hale', '12/03/1958', '(503) 555-0678', 'p.hale@email.com',
    '04/18/2015', '9903', { street: '2211 Alder Ct', city: 'Portland', state: 'OR', zip: '97202' }, 'forest',
    { alert: 'Account restricted \u2014 supervisor review required',
      accounts: [
        mkAcct('Savings', '78901-S1', '00', 15750.00, '04/18/2015', [
          { date: '07/01/2026', desc: 'Interest Payment', debit: null, credit: 750.00 },
          { date: '05/15/2026', desc: 'Opening Deposit', debit: null, credit: 15000.00 },
          ...genTxs('Savings', 15, 60),
        ]),
        mkAcct('Checking', '78901-C1', '01', 3200.00, '04/18/2015', [
          { date: '05/15/2026', desc: 'Opening Deposit', debit: null, credit: 3200.00 },
          ...genTxs('Checking', 12, 61),
        ]),
      ],
    }),

  '11111': mkMember('Sarah Mitchell', '06/12/1983', '(503) 555-0789', 's.mitchell@email.com',
    '05/20/2019', '3156', { street: '892 Pine Ave', city: 'Portland', state: 'OR', zip: '97210' }, 'cascade',
    { jointWith: { name: 'Jane Thompson', memberId: '12345' },
      secondaryNames: [{ name: 'Jane Thompson', relationship: 'Joint Owner', dob: '03/15/1985' }],
      accounts: [
        mkAcct('Savings', '11111-S1', '00', 3450.00, '05/20/2019'),
        mkAcct('Checking', '11111-C1', '01', 2100.00, '05/20/2019'),
      ],
      loans: [
        // Delinquent — 29 days past due
        { loanId: 'L-11111-01', type: 'Auto Loan', balance: 12500.00, rate: 5.90,
          nextPaymentDue: '07/15/2026', monthlyPayment: 242.00, opened: '01/10/2025', status: 'Active',
          payments: [
            { date: '05/15/2026', amount: 242.00, ref: 'LP-4020' },
            { date: '06/15/2026', amount: 242.00, ref: 'LP-4021' },
          ] },
      ],
    }),

  '22222': mkMember('Michael Rivera', '04/25/1975', '(503) 555-0890', 'm.rivera@email.com',
    '06/01/2020', '4467', { street: '1530 Hawthorne Blvd', city: 'Gresham', state: 'OR', zip: '97030' }, 'harbor',
    { accounts: [
        mkAcct('Savings', '22222-S1', '00', 6200.00, '06/01/2020'),
        mkAcct('Checking', '22222-C1', '01', 4500.00, '06/01/2020'),
      ],
      loans: [
        { loanId: 'L-22222-01', type: 'Mortgage', balance: 185432.10, rate: 6.25,
          nextPaymentDue: '09/01/2026', monthlyPayment: 1245.00, opened: '06/01/2020', status: 'Active',
          payments: [
            { date: '06/01/2026', amount: 1245.00, ref: 'LP-4030' },
            { date: '07/01/2026', amount: 1245.00, ref: 'LP-4031' },
            { date: '08/01/2026', amount: 1245.00, ref: 'LP-4032' },
          ] },
      ],
      notes: [{ timestamp: '07/15/2026 11:20', operator: 'operator', type: 'Comment', text: 'Requested payoff statement for mortgage.' }],
    }),

  '33333': mkMember('Karen Walsh', '10/08/1988', '(971) 555-0123', 'k.walsh@email.com',
    '08/22/2018', '1190', { street: '4200 Cornell Rd', city: 'Hillsboro', state: 'OR', zip: '97124' }, 'meadow',
    { accounts: [
        mkAcct('Savings', '33333-S1', '00', 1800.00, '08/22/2018'),
        mkAcct('Checking', '33333-C1', '01', 3200.00, '08/22/2018'),
        mkAcct('Money Market', '33333-M1', '10', 8000.00, '02/15/2022'),
      ],
      loans: [
        { loanId: 'L-33333-01', type: 'Auto Loan', balance: 8200.00, rate: 4.75,
          nextPaymentDue: '09/10/2026', monthlyPayment: 310.00, opened: '09/01/2024', status: 'Active',
          payments: [
            { date: '07/10/2026', amount: 310.00, ref: 'LP-4040' },
            { date: '08/10/2026', amount: 310.00, ref: 'LP-4041' },
          ] },
        { loanId: 'L-33333-02', type: 'Personal Loan', balance: 3500.00, rate: 8.50,
          nextPaymentDue: '09/01/2026', monthlyPayment: 175.00, opened: '03/15/2026', status: 'Active',
          payments: [
            { date: '07/01/2026', amount: 175.00, ref: 'LP-4042' },
            { date: '08/01/2026', amount: 175.00, ref: 'LP-4043' },
          ] },
      ],
    }),

  '44444': mkMember('Thomas Nguyen', '03/17/1995', '(503) 555-0234', 't.nguyen@email.com',
    '01/15/2026', '6601', { street: '950 Division St', city: 'Portland', state: 'OR', zip: '97202' }, 'sunset',
    { accounts: [
        mkAcct('Savings', '44444-S1', '00', 100.00, '01/15/2026',
          [{ date: '01/15/2026', desc: 'Opening Deposit', debit: null, credit: 100.00 }],
          { status: 'Dormant' }),
      ],
      // Delinquent loan on dormant member
      loans: [
        { loanId: 'L-44444-01', type: 'Auto Loan', balance: 5500.00, rate: 5.25,
          nextPaymentDue: '07/01/2026', monthlyPayment: 195.00, opened: '06/01/2025', status: 'Active',
          payments: [
            { date: '06/01/2026', amount: 195.00, ref: 'LP-4070' },
          ] },
      ],
    }),

  '55555': mkMember('Amanda Foster', '08/30/1980', '(503) 555-0345', 'a.foster@email.com',
    '11/01/2017', '7734', { street: '3315 Burnside St', city: 'Milwaukie', state: 'OR', zip: '97222' }, 'eagle',
    { accounts: [
        mkAcct('Savings', '55555-S1', '00', 9300.00, '11/01/2017'),
        mkAcct('Checking', '55555-C1', '01', 2750.00, '11/01/2017'),
      ],
      loans: [
        { loanId: 'L-55555-01', type: 'Home Equity', balance: 42000.00, rate: 7.50,
          nextPaymentDue: '09/01/2026', monthlyPayment: 520.00, opened: '11/01/2022', status: 'Active',
          payments: [
            { date: '06/01/2026', amount: 520.00, ref: 'LP-4050' },
            { date: '07/01/2026', amount: 520.00, ref: 'LP-4051' },
            { date: '08/01/2026', amount: 520.00, ref: 'LP-4052' },
          ] },
      ],
    }),

  '66666': mkMember('Richard Kim', '02/14/1972', '(503) 555-0456', 'r.kim@email.com',
    '04/10/2014', '3382', { street: '7800 Willamette Dr', city: 'West Linn', state: 'OR', zip: '97068' }, 'cedar',
    { accounts: [
        mkAcct('Savings', '66666-S1', '00', 4000.00, '04/10/2014'),
        mkAcct('Money Market', '66666-M1', '10', 25000.00, '01/15/2018'),
        mkAcct('CD', '66666-D1', '20', 50000.00, '06/01/2025', undefined, { available: 0 }),
      ],
    }),

  '77777': mkMember('Jennifer Ortiz', '11/25/1986', '(971) 555-0567', 'j.ortiz@email.com',
    '09/30/2019', '5519', { street: '2100 Boones Ferry Rd', city: 'Tualatin', state: 'OR', zip: '97062' }, 'granite',
    { alert: 'Under review for recent address change',
      accounts: [
        mkAcct('Savings', '77777-S1', '00', 7100.00, '09/30/2019'),
        mkAcct('Checking', '77777-C1', '01', 1450.00, '09/30/2019'),
      ],
    }),

  '88888': mkMember('William Davis', '07/19/1991', '(503) 555-0678', 'w.davis@email.com',
    '02/12/2017', '4405', { street: '1922 Spruce Way', city: 'Tigard', state: 'OR', zip: '97223' }, 'valley',
    { jointWith: { name: 'Lisa Williams', memberId: '56789' },
      secondaryNames: [{ name: 'Lisa Williams', relationship: 'Joint Owner', dob: '09/14/1992' }],
      accounts: [
        mkAcct('Savings', '88888-S1', '00', 5800.00, '02/12/2017'),
        mkAcct('Checking', '88888-C1', '01', 3100.00, '03/01/2017'),
        mkAcct('Money Market', '88888-M1', '10', 12000.00, '06/15/2020'),
      ],
    }),

  '10101': mkMember('Angela Thompson', '05/02/1994', '(971) 555-0789', 'a.thompson@email.com',
    '10/15/2021', '8812', { street: '540 Alberta St', city: 'Portland', state: 'OR', zip: '97217' }, 'willow',
    { accounts: [
        mkAcct('Savings', '10101-S1', '00', 2200.00, '10/15/2021'),
        mkAcct('Checking', '10101-C1', '01', 1850.00, '10/15/2021'),
      ],
    }),
};

// ── Audit log ───────────────────────────────────────────────
const auditLog = [];

function addAudit(operator, action, memberId, details) {
  auditLog.unshift({
    timestamp: new Date().toLocaleString('en-US'),
    operator, action,
    memberId: memberId || '',
    details: details || '',
  });
}

// ── Counters ────────────────────────────────────────────────
let _acctSeq = 900001, _refSeq = 1001, _lpSeq = 5001, _appSeq = 1, _chkSeq = 8001;

function getNextAcctNum(memberId) { return `${memberId}-N${_acctSeq++}`; }
function getNextRef() { return `REF-${_refSeq++}`; }
function getNextLoanPayRef() { return `LP-${_lpSeq++}`; }
function getNextAppId() { return `APP-${String(_appSeq++).padStart(4, '0')}`; }
function getNextCheckNum() { return `CHK-${_chkSeq++}`; }

// ── Helpers ─────────────────────────────────────────────────
function findAccount(member, acctNum) {
  return member.accounts.find(a => a.number === acctNum) || null;
}
function findLoan(member, loanId) {
  return (member.loans || []).find(l => l.loanId === loanId) || null;
}
function memberLastName(member) {
  const parts = member.name.split(' ');
  return parts[parts.length - 1];
}
function searchByLastName(name) {
  const q = name.toLowerCase();
  const results = [];
  for (const [id, m] of Object.entries(MEMBERS)) {
    if (memberLastName(m).toLowerCase() === q) results.push({ id, member: m });
  }
  return results;
}
function totalShares() {
  let sum = 0;
  for (const m of Object.values(MEMBERS)) {
    for (const a of m.accounts) sum += a.balance;
  }
  return sum;
}
function todayTxCount() {
  const td = new Date();
  const todayStr = `${String(td.getMonth()+1).padStart(2,'0')}/${String(td.getDate()).padStart(2,'0')}/${td.getFullYear()}`;
  let count = 0;
  for (const m of Object.values(MEMBERS)) {
    for (const a of m.accounts) {
      for (const tx of a.transactions) { if (tx.date === todayStr) count++; }
    }
  }
  return count;
}
function getDelinquentLoans() {
  const now = new Date();
  const results = [];
  for (const [id, m] of Object.entries(MEMBERS)) {
    for (const ln of (m.loans || [])) {
      if (!ln.nextPaymentDue) continue;
      const [mo, dy, yr] = ln.nextPaymentDue.split('/');
      const due = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy));
      if (due < now) {
        const daysLate = Math.floor((now - due) / 86400000);
        results.push({ memberId: id, memberName: m.name, loan: ln, daysLate });
      }
    }
  }
  return results.sort((a, b) => b.daysLate - a.daysLate);
}
function eodTotals() {
  const t = { deposits: 0, withdrawals: 0, transfers: 0, overrides: 0 };
  const td = new Date().toLocaleDateString('en-US');
  for (const e of auditLog) {
    // Match today's entries by checking if timestamp starts with today's date
    if (!e.timestamp.startsWith(td)) continue;
    if (e.action === 'TELLER_DEPOSIT') t.deposits++;
    if (e.action === 'TELLER_WITHDRAWAL' || e.action === 'TELLER_WITHDRAWAL_OVERRIDE') t.withdrawals++;
    if (e.action === 'TRANSFER') t.transfers++;
    if (e.action === 'TELLER_WITHDRAWAL_OVERRIDE') t.overrides++;
  }
  return t;
}

module.exports = {
  CREDENTIALS, SUB_ACCOUNT_TYPES, MEMBERS,
  auditLog, addAudit,
  findAccount, findLoan, memberLastName, searchByLastName,
  totalShares, todayTxCount, getDelinquentLoans, eodTotals,
  getNextAcctNum, getNextRef, getNextLoanPayRef, getNextAppId, getNextCheckNum,
};
