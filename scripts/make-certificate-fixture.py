#!/usr/bin/env python3
"""Generate one SYNTHETIC quarterly compliance certificate (PDF) for BOR-09, 2026-Q3.

The borrower adds back projected cost savings with no cap, which turns two covenant failures into
"in compliance". The unadjusted figures equal the 2026-Q3 row of data/team/loan_covenants_extended.csv
(record COV-09-3) and the statements in data/statements/BOR-09_2026-Q3.pdf; the add-backs are the
borrower's own claim and are not part of the fictional loan policy's EBITDA definition.

Outputs, in data/statements/certificates/:
  BOR-09_2026-Q3_certificate.pdf   one page, "SYNTHETIC" banner
  certificate-fixture.json         every printed value (money in cents as strings) and its page

Deterministic: integer cents only, reportlab invariant mode, uncompressed page stream.
Run: python3 scripts/make-certificate-fixture.py      Requires: reportlab (fixtures only).
"""
import json
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'statements', 'certificates')
BANNER = 'SYNTHETIC TEST DOCUMENT - fictional borrower, made by the Covenant Monitor team. Not a real certificate.'

# All money in cents.
STATEMENT_EBITDA = 32500000          # TTM EBITDA per the statements (CSV ttm_ebitda_usd 325,000.00)
ADDBACKS = 11000000                  # projected cost savings and synergies, uncapped
STATEMENT_ACF = 30000000             # CSV ttm_available_cashflow_usd 300,000.00
DEBT = 127000000                     # CSV debt_usd 1,270,000.00
DEBT_SERVICE = 26000000              # CSV ttm_debt_service_usd 260,000.00


def usd(cents):
    neg = cents < 0
    cents = abs(cents)
    s = f'{cents // 100:,}.{cents % 100:02d}'
    return f'({s})' if neg else s


def ratio2(n, d):
    """n/d rounded half up to two decimals, as text (integer arithmetic)."""
    q, r = divmod(n * 100, d)
    if 2 * r >= d:
        q += 1
    return f'{q // 100}.{q % 100:02d}'


def values():
    adj_ebitda = STATEMENT_EBITDA + ADDBACKS
    adj_acf = STATEMENT_ACF + ADDBACKS
    return {
        'borrower_id': 'BOR-09',
        'period': '2026-Q3',
        'statement_ebitda': STATEMENT_EBITDA,
        'cost_savings_addbacks': ADDBACKS,
        'reported_ebitda': adj_ebitda,
        'total_debt': DEBT,
        'reported_leverage': ratio2(DEBT, adj_ebitda),          # 2.92
        'statement_available_cash_flow': STATEMENT_ACF,
        'reported_available_cash_flow': adj_acf,
        'debt_service': DEBT_SERVICE,
        'reported_dscr': ratio2(adj_acf, DEBT_SERVICE),         # 1.58
        'certified_compliant': 'Yes',
        'addback_cap': 'None',
    }


def draw(path, v):
    W, H = letter
    cv = canvas.Canvas(path, pagesize=(W, H), invariant=1, pageCompression=0)
    cv.setTitle('BOR-09 compliance certificate, quarter ended Sep 30, 2026 (SYNTHETIC)')
    cv.setAuthor('Covenant Monitor team (synthetic fixture)')
    cv.setSubject('SYNTHETIC test data')
    cv.setFillGray(0.35)
    cv.setFont('Helvetica-Bold', 8)
    cv.drawString(40, H - 28, BANNER)
    cv.setFillGray(0)
    cv.setFont('Helvetica-Bold', 15)
    cv.drawString(40, H - 60, 'Quarterly Compliance Certificate (SYNTHETIC)')
    cv.setFont('Helvetica', 10.5)
    cv.drawString(40, H - 80, 'Borrower: BOR-09 Synthetic Borrower (borrower ID BOR-09)')
    cv.drawString(40, H - 95, 'Fiscal quarter ended Sep 30, 2026 (2026-Q3). Trailing twelve months, in US dollars.')

    rows = [
        ('head', 'Leverage', None),
        ('line', 'Consolidated EBITDA per the financial statements', usd(v['statement_ebitda'])),
        ('line', 'Add: projected cost savings, operating improvements and synergies', usd(v['cost_savings_addbacks'])),
        ('line', 'Cap applied to cost-savings add-backs', v['addback_cap']),
        ('total', 'Adjusted EBITDA', usd(v['reported_ebitda'])),
        ('line', 'Total funded debt', usd(v['total_debt'])),
        ('total', 'Total Leverage Ratio (maximum 3.00x)', v['reported_leverage'] + 'x'),
        ('head', 'Debt service coverage', None),
        ('line', 'Available cash flow per the financial statements', usd(v['statement_available_cash_flow'])),
        ('line', 'Add: projected cost savings, operating improvements and synergies', usd(v['cost_savings_addbacks'])),
        ('total', 'Adjusted available cash flow', usd(v['reported_available_cash_flow'])),
        ('line', 'Debt service (interest and scheduled principal)', usd(v['debt_service'])),
        ('total', 'Debt Service Coverage Ratio (minimum 1.20x)', v['reported_dscr'] + 'x'),
    ]
    y = H - 135
    for kind, label, val in rows:
        if kind == 'head':
            y -= 6
            cv.setFont('Helvetica-Bold', 11)
            cv.drawString(40, y, label)
            y -= 20
            continue
        cv.setFont('Helvetica-Bold' if kind == 'total' else 'Helvetica', 10.5)
        cv.drawString(56, y, label)
        cv.drawRightString(W - 60, y, val)
        if kind == 'total':
            cv.setLineWidth(0.5)
            cv.line(W - 160, y + 12, W - 60, y + 12)
        y -= 19

    y -= 14
    cv.setFont('Helvetica-Bold', 11)
    cv.drawString(40, y, 'Certification')
    y -= 20
    cv.setFont('Helvetica', 10.5)
    for line in ['The undersigned officer certifies that, as of the end of the fiscal quarter above, the',
                 'Borrower is in compliance with each financial covenant in the loan agreement.']:
        cv.drawString(56, y, line)
        y -= 15
    y -= 6
    cv.drawString(56, y, 'In compliance with all financial covenants:')
    cv.setFont('Helvetica-Bold', 10.5)
    cv.drawRightString(W - 60, y, v['certified_compliant'])
    y -= 34
    cv.setFont('Helvetica', 10.5)
    cv.drawString(56, y, 'Signed: Chief Financial Officer, BOR-09 Synthetic Borrower (fictional)')
    y -= 15
    cv.drawString(56, y, 'Date: Oct 30, 2026')
    cv.setFillGray(0.35)
    cv.setFont('Helvetica', 8)
    cv.drawString(40, 36, 'SYNTHETIC - generated by scripts/make-certificate-fixture.py for testing. Page 1 of 1.')
    cv.showPage()
    cv.save()


def main():
    os.makedirs(OUT, exist_ok=True)
    v = values()
    name = 'BOR-09_2026-Q3_certificate.pdf'
    draw(os.path.join(OUT, name), v)
    fx = {'synthetic': True, 'generator': 'scripts/make-certificate-fixture.py', 'pdf': name, 'record_id': 'COV-09-3',
          'units': 'cents for money, text for ratios and answers', 'page': 1,
          'values': {k: str(x) for k, x in v.items()}}
    with open(os.path.join(OUT, 'certificate-fixture.json'), 'w', newline='\n') as f:
        json.dump(fx, f, indent=1, sort_keys=True)
        f.write('\n')
    print('Wrote', name, 'and certificate-fixture.json')


if __name__ == '__main__':
    main()
