#!/usr/bin/env python3
"""Generate SYNTHETIC quarterly financial statements (PDF) for BOR-09 and BOR-01.

Deterministic: integer cents only, reportlab invariant mode, uncompressed page streams.
Outputs, in data/statements/:
  BOR-09_2026-Q3.pdf, BOR-01_2026-Q3.pdf  three pages each (income statement, balance sheet,
                                          cash flow statement), four quarterly columns 2025-Q4..2026-Q3
  fixtures.json                           every printed number (cents as strings) and its page

The four quarters are built so that, under data/statements/definitions.txt, they sum exactly to the
2026-Q3 row of data/team/loan_covenants_extended.csv. tests/statement-fixtures.test.js recomputes that
row from fixtures.json to the cent and checks that each balance sheet balances and cash rolls forward.

The balance sheet is a true roll-forward from an opening (2025-Q3) balance sheet: net income goes to
retained earnings, every cash flow moves cash, finance-lease additions move PP&E and lease debt, so the
balance sheet balances by construction rather than by a plug. Current assets and current liabilities are
pinned to the CSV quarters; the residual cash need is met by long-term investments (cash flow from investing).

Run: python3 scripts/make-statement-fixtures.py
Requires: reportlab (only for generating these fixtures).
"""
import json
import os
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'statements')
QUARTERS = ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']
QUARTER_END = {'2025-Q4': 'Dec 31, 2025', '2026-Q1': 'Mar 31, 2026', '2026-Q2': 'Jun 30, 2026', '2026-Q3': 'Sep 30, 2026'}


def c(dollars):
    """'1,234.56' or 1234 -> integer cents, exact."""
    s = str(dollars).replace(',', '')
    neg = s.startswith('-')
    s = s.lstrip('-')
    whole, _, frac = s.partition('.')
    n = int(whole) * 100 + int((frac + '00')[:2])
    return -n if neg else n


# Per-borrower inputs. All money in cents. Quarter lists are 2025-Q4, 2026-Q1, 2026-Q2, 2026-Q3.
BORROWERS = {
    'BOR-09': dict(
        name='BOR-09 Synthetic Borrower',
        revenue=[c('1182416.35'), c('1175902.80'), c('1161337.25'), c('1148844.60')],
        ebitda=[c(84000), c(82500), c(80500), c(78000)],           # TTM 325,000.00
        da=[c(20000)] * 4,
        cogs_share_bps=6800,                                        # cost of sales as a share of revenue (display split only)
        interest=[c(40000)] * 4,                                    # TTM 160,000.00
        tax=[c(4000), c(4000), c(3500), c(3500)],                   # TTM 15,000.00 (expense = cash paid)
        capex=[c(9000), c(8500), c(9000), c(8500)],                 # TTM 35,000.00 unfinanced
        distributions=[0] * 4,
        term_principal=[c(20000)] * 4, lease_principal=[c(5000)] * 4,
        new_leases=[c(25000)] * 4,                                  # equipment acquired under finance leases (non-cash)
        revolver_draws=None,                                        # no revolver disclosed (CSV revolver columns are blank)
        revolver_commitment=None,
        owc_change=[c(-10000), c(5000), c(-8000), c(-12000)],       # change in operating working capital; TTM -25,000 = 25,000 release
        ca=[c(930000), c(920000), c(910000), c(900000)],            # 2026 quarters from the CSV
        cl=[c(600000), c(600000), c(600000), c(600000)],
        opening=dict(cash=c(238000), owc=c(180000), ppe=c(1450000), lti=c(150000),
                     revolver=0, term=c(1230000), lease=c(40000), common=c(500000)),
        current_term=c(80000), current_lease=c(20000),
    ),
    'BOR-01': dict(
        name='BOR-01 Synthetic Borrower',
        revenue=[c('1296750.40'), c('1288114.95'), c('1270563.10'), c('1251902.55')],
        ebitda=[c(95000), c(93000), c(90500), c(86500)],            # TTM 365,000.00
        da=[c(22500)] * 4,
        cogs_share_bps=6700,
        interest=[c(40000)] * 4,                                    # TTM 160,000.00
        tax=[c(5500), c(5000), c(5000), c(4500)],                   # TTM 20,000.00
        capex=[c(12500), c(13000), c(12000), c(12500)],             # TTM 50,000.00
        distributions=[0] * 4,
        term_principal=[c(20000)] * 4, lease_principal=[c(5000)] * 4,
        new_leases=[0] * 4,
        revolver_draws=[c(25000)] * 4,                              # balance 75k, 100k, 125k, 150k (CSV 2026-Q1..Q3)
        revolver_commitment=c(500000),
        owc_change=[c(3000), c(-4000), c(2000), c(-6000)],          # TTM -5,000 = 5,000 release
        ca=[c(915000), c(900000), c(880000), c(860000)],
        cl=[c(600000), c(600000), c(600000), c(610000)],
        opening=dict(cash=c(205000), owc=c(190000), ppe=c(1320000), lti=c(120000),
                     revolver=c(50000), term=c(920000), lease=c(60000), common=c(450000)),
        current_term=c(80000), current_lease=c(20000),
    ),
}


def build(p):
    """Roll the opening balance sheet forward one quarter at a time. Returns {quarter: {item: cents}}."""
    o = p['opening']
    cur_debt = p['current_term'] + p['current_lease']
    # Opening balance sheet: noncurrent liabilities and equity; retained earnings is the opening balance.
    cash, owc, ppe, lti = o['cash'], o['owc'], o['ppe'], o['lti']
    revolver, term, lease = o['revolver'], o['term'], o['lease']
    opening_assets_net = cash + owc + ppe + lti
    retained = opening_assets_net - revolver - term - lease - o['common']
    out = {}
    for i, q in enumerate(QUARTERS):
        rev, ebitda, da = p['revenue'][i], p['ebitda'][i], p['da'][i]
        op_inc = ebitda - da
        opex = rev - op_inc
        cogs = rev * p['cogs_share_bps'] // 10000
        sga = opex - da - cogs
        interest, tax = p['interest'][i], p['tax'][i]
        pre_tax = op_inc - interest
        ni = pre_tax - tax
        d_owc = p['owc_change'][i]
        wc_line = -d_owc                       # cash flow line: decrease (increase) in operating working capital
        cfo = ni + da + wc_line
        capex = p['capex'][i]
        draws = p['revolver_draws'][i] if p['revolver_draws'] else 0
        tp, lp, dist, nl = p['term_principal'][i], p['lease_principal'][i], p['distributions'][i], p['new_leases'][i]
        cff = draws - tp - lp - dist
        # Balance sheet at quarter end.
        owc += d_owc
        revolver += draws
        term -= tp
        lease += nl - lp
        ppe += capex + nl - da
        retained += ni - dist
        ca, cl = p['ca'][i], p['cl'][i]
        ap_accrued = cl - cur_debt
        ar_inv = owc + ap_accrued
        new_cash = ca - ar_inv
        # Residual cash need met by long-term investments (purchase is a cash outflow).
        invest = cash + cfo - capex + cff - new_cash      # amount put into (positive) or taken out of (negative) investments
        lti += invest
        cfi = -capex - invest
        assert cfo + cfi + cff == new_cash - cash, q
        begin_cash, cash = cash, new_cash
        ar = ar_inv * 55 // 100
        inventory = ar_inv - ar
        ap = ap_accrued * 64 // 100
        accrued = ap_accrued - ap
        total_assets = cash + ar + inventory + ppe + lti
        current_portion = cur_debt
        long_term = term + lease - cur_debt
        total_liab = ap + accrued + current_portion + revolver + long_term
        equity = o['common'] + retained
        assert total_assets == total_liab + equity, q
        assert ar + inventory + cash == ca and ap + accrued + current_portion == cl, q
        row = dict(
            revenue=rev, cost_of_sales=cogs, selling_general_administrative=sga, depreciation_amortization=da,
            operating_expenses=opex, operating_income=op_inc, interest_expense=interest, income_before_tax=pre_tax,
            income_tax_expense=tax, net_income=ni,
            cash=cash, accounts_receivable=ar, inventory=inventory, current_assets=ca, property_equipment_net=ppe,
            long_term_investments=lti, total_assets=total_assets, accounts_payable=ap, accrued_liabilities=accrued,
            current_portion_ltd=current_portion, current_liabilities=cl, long_term_debt=long_term,
            total_liabilities=total_liab, common_stock=o['common'], retained_earnings=retained, total_equity=equity,
            total_liabilities_and_equity=total_liab + equity, term_loan=term, finance_lease=lease,
            total_debt=revolver + term + lease,
            change_in_working_capital=wc_line, cash_from_operations=cfo, capex=capex, investments_net=invest,
            cash_from_investing=cfi, term_loan_repayment=tp, finance_lease_principal=lp, distributions=dist,
            cash_from_financing=cff, net_change_in_cash=cash - begin_cash, cash_beginning=begin_cash, cash_end=cash,
            cash_interest_paid=interest, cash_taxes=tax, scheduled_principal=tp + lp, finance_lease_additions=nl,
        )
        if p['revolver_draws'] is not None:
            row.update(revolver_drawn=revolver, revolver_net_borrowings=draws, revolver_commitment=p['revolver_commitment'])
        out[q] = row
    return out


def fmt(n, paren=False):
    neg = n < 0
    n = abs(n)
    s = f"{n // 100:,}.{n % 100:02d}"
    if neg:
        return f"({s})" if paren else f"-{s}"
    return s


# Page layout: (label, key, style, sign) where sign=-1 prints the value as a negative (outflow).
def pages(has_revolver):
    income = [
        ('Revenue', 'revenue', 'line', 1),
        ('Cost of sales', 'cost_of_sales', 'indent', 1),
        ('Selling, general and administrative expenses', 'selling_general_administrative', 'indent', 1),
        ('Depreciation and amortization', 'depreciation_amortization', 'indent', 1),
        ('Total operating expenses', 'operating_expenses', 'total', 1),
        ('Operating income', 'operating_income', 'total', 1),
        ('Interest expense', 'interest_expense', 'line', 1),
        ('Income before income taxes', 'income_before_tax', 'total', 1),
        ('Income tax expense', 'income_tax_expense', 'line', 1),
        ('Net income', 'net_income', 'grand', 1),
    ]
    balance = [
        ('ASSETS', None, 'head', 1),
        ('Cash and cash equivalents', 'cash', 'indent', 1),
        ('Accounts receivable', 'accounts_receivable', 'indent', 1),
        ('Inventory', 'inventory', 'indent', 1),
        ('Total current assets', 'current_assets', 'total', 1),
        ('Property and equipment, net', 'property_equipment_net', 'line', 1),
        ('Long-term investments', 'long_term_investments', 'line', 1),
        ('Total assets', 'total_assets', 'grand', 1),
        ('LIABILITIES AND EQUITY', None, 'head', 1),
        ('Accounts payable', 'accounts_payable', 'indent', 1),
        ('Accrued liabilities', 'accrued_liabilities', 'indent', 1),
        ('Current portion of long-term debt', 'current_portion_ltd', 'indent', 1),
        ('Total current liabilities', 'current_liabilities', 'total', 1),
    ] + ([('Revolving loan', 'revolver_drawn', 'line', 1)] if has_revolver else []) + [
        ('Long-term debt, net of current portion', 'long_term_debt', 'line', 1),
        ('Total liabilities', 'total_liabilities', 'total', 1),
        ('Common stock', 'common_stock', 'indent', 1),
        ('Retained earnings', 'retained_earnings', 'indent', 1),
        ('Total equity', 'total_equity', 'total', 1),
        ('Total liabilities and equity', 'total_liabilities_and_equity', 'grand', 1),
        ('DEBT SUMMARY (period-end balances)', None, 'head', 1),
    ] + ([('Revolving loan', 'revolver_drawn', 'indent', 1)] if has_revolver else []) + [
        ('Term loan', 'term_loan', 'indent', 1),
        ('Finance lease liabilities', 'finance_lease', 'indent', 1),
        ('Total debt', 'total_debt', 'total', 1),
    ] + ([('Revolving credit commitment', 'revolver_commitment', 'indent', 1)] if has_revolver else [])
    cash_flow = [
        ('OPERATING ACTIVITIES', None, 'head', 1),
        ('Net income', 'net_income', 'indent', 1),
        ('Depreciation and amortization', 'depreciation_amortization', 'indent', 1),
        ('Decrease (increase) in operating working capital', 'change_in_working_capital', 'indent', 1),
        ('Net cash provided by operating activities', 'cash_from_operations', 'total', 1),
        ('INVESTING ACTIVITIES', None, 'head', 1),
        ('Purchases of property and equipment', 'capex', 'indent', -1),
        ('Net (purchases) sales of long-term investments', 'investments_net', 'indent', -1),
        ('Net cash used in investing activities', 'cash_from_investing', 'total', 1),
        ('FINANCING ACTIVITIES', None, 'head', 1),
    ] + ([('Net borrowings under revolving loan', 'revolver_net_borrowings', 'indent', 1)] if has_revolver else []) + [
        ('Repayment of term loan', 'term_loan_repayment', 'indent', -1),
        ('Principal payments on finance leases', 'finance_lease_principal', 'indent', -1),
        ('Distributions to owners', 'distributions', 'indent', -1),
        ('Net cash provided by (used in) financing activities', 'cash_from_financing', 'total', 1),
        ('Net change in cash', 'net_change_in_cash', 'total', 1),
        ('Cash at beginning of quarter', 'cash_beginning', 'line', 1),
        ('Cash at end of quarter', 'cash_end', 'grand', 1),
        ('SUPPLEMENTAL INFORMATION', None, 'head', 1),
        ('Cash interest paid', 'cash_interest_paid', 'indent', 1),
        ('Income taxes paid', 'cash_taxes', 'indent', 1),
        ('Scheduled principal payments (term loan and finance leases)', 'scheduled_principal', 'indent', 1),
        ('Equipment acquired under finance leases (non-cash)', 'finance_lease_additions', 'indent', 1),
    ]
    return [('Income Statement', 'For the quarters ended', income),
            ('Balance Sheet', 'As of', balance),
            ('Statement of Cash Flows', 'For the quarters ended', cash_flow)]


BANNER = 'SYNTHETIC - team-made test fixture for Covenant Monitor. Not real financial statements.'


def draw_pdf(path, bid, p, data):
    W, H = landscape(letter)
    cv = canvas.Canvas(path, pagesize=(W, H), invariant=1, pageCompression=0)
    cv.setTitle(f'{bid} quarterly financial statements (SYNTHETIC)')
    cv.setAuthor('Covenant Monitor team (synthetic fixture)')
    cv.setSubject('SYNTHETIC test data')
    page_of = {}
    layout = pages(p['revolver_draws'] is not None)
    for pno, (title, period_word, lines) in enumerate(layout, start=1):
        cv.setFillGray(0.35)
        cv.setFont('Helvetica-Bold', 9)
        cv.drawString(40, H - 28, BANNER)
        cv.setFillGray(0)
        cv.setFont('Helvetica-Bold', 15)
        cv.drawString(40, H - 58, f"{p['name']} (SYNTHETIC)")
        cv.setFont('Helvetica', 12)
        cv.drawString(40, H - 76, f'{title} - unaudited, in US dollars')
        x_cols = [430, 520, 610, 700]
        y = H - 108
        cv.setFont('Helvetica-Bold', 9)
        cv.drawString(40, y, period_word)
        for x, q in zip(x_cols, QUARTERS):
            cv.drawRightString(x + 60, y, q)
            cv.setFont('Helvetica', 8)
            cv.drawRightString(x + 60, y - 11, QUARTER_END[q])
            cv.setFont('Helvetica-Bold', 9)
        y -= 20
        cv.line(40, y + 4, W - 40, y + 4)
        step = 16 if len(lines) <= 20 else 14.5
        for label, key, style, sign in lines:
            y -= step
            if style == 'head':
                cv.setFont('Helvetica-Bold', 9)
                cv.drawString(40, y, label)
                continue
            bold = style in ('total', 'grand')
            cv.setFont('Helvetica-Bold' if bold else 'Helvetica', 9.5)
            cv.drawString(56 if style == 'indent' else 40, y, label)
            for x, q in zip(x_cols, QUARTERS):
                v = data[q][key] * sign
                cv.drawRightString(x + 60, y, fmt(v, paren=True))
            if style == 'grand':
                cv.line(430, y - 3, W - 40, y - 3)
            page_of.setdefault(key, pno)
        cv.setFont('Helvetica', 8)
        cv.setFillGray(0.35)
        cv.drawString(40, 24, f'{bid} - {title} - page {pno} of {len(layout)} - SYNTHETIC: generated by scripts/make-statement-fixtures.py')
        cv.setFillGray(0)
        cv.showPage()
    cv.save()
    return page_of


def main():
    os.makedirs(OUT, exist_ok=True)
    fixtures = {'synthetic': True, 'generator': 'scripts/make-statement-fixtures.py',
                'definitions': 'statements/definitions.txt', 'quarters': QUARTERS, 'borrowers': {}}
    for bid, p in BORROWERS.items():
        data = build(p)
        name = f'{bid}_2026-Q3.pdf'
        page_of = draw_pdf(os.path.join(OUT, name), bid, p, data)
        fixtures['borrowers'][bid] = {
            'pdf': name,
            'period': '2026-Q3',
            'quarters': {q: {k: str(v) for k, v in data[q].items()} for q in QUARTERS},
            'pages': page_of,
            'units': 'cents',
        }
    with open(os.path.join(OUT, 'fixtures.json'), 'w', newline='\n') as f:
        json.dump(fixtures, f, indent=1, sort_keys=True)
        f.write('\n')
    print('Wrote', ', '.join(f"{b}_2026-Q3.pdf" for b in BORROWERS), 'and fixtures.json')


if __name__ == '__main__':
    main()
