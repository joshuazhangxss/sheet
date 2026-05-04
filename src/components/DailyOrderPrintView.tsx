import type { DailyColorGroup, DailyOrderRow } from '../types';

type DailyOrderPrintViewProps = {
  rows: DailyOrderRow[];
  colorGroups: DailyColorGroup[];
  listMode: 'orders' | 'colors';
};

function formatDailyItemSummary(items: DailyOrderRow['items']): string {
  return items
    .map((item) => (item.qty > 1 ? `${item.size} x${item.qty}` : item.size || '待确认'))
    .join('、');
}

function formatDailyTimeLabel(value: string): string {
  return value.replace('T', ' ');
}

function renderOrderRows(rows: DailyOrderRow[]) {
  return (
    <table className="daily-print-table">
      <thead>
        <tr>
          <th scope="col">本地时间</th>
          <th scope="col">订单号</th>
          <th scope="col">订单内容</th>
          <th scope="col">颜色</th>
          <th scope="col">标记</th>
          <th scope="col">加急</th>
          <th scope="col">总数量</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.rush ? 'is-rush' : undefined}>
            <td>{formatDailyTimeLabel(row.purchaseDate)}</td>
            <td>{row.amazonOrderId || '—'}</td>
            <td>{formatDailyItemSummary(row.items)}</td>
            <td>{row.color || '待确认'}</td>
            <td>{row.marks || '—'}</td>
            <td>{row.rush ? '★' : '—'}</td>
            <td>{row.totalQty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderColorGroups(groups: DailyColorGroup[]) {
  return (
    <div className="daily-print-color-board">
      {groups.map((group) => (
        <section key={group.color} className="daily-print-color-group">
          <header className="daily-print-color-header">
            <div>
              <span className="daily-print-kicker">颜色</span>
              <h2>{group.color}</h2>
            </div>
            <strong>x{group.totalQty}</strong>
          </header>

          {group.normalRows.length > 0 ? (
            <section className="daily-print-color-section">
              <div className="daily-print-subtitle">常规</div>
              <table className="daily-print-table daily-print-table--compact">
                <thead>
                  <tr>
                    <th scope="col">尺寸</th>
                    <th scope="col">数量</th>
                    <th scope="col">标记</th>
                    <th scope="col">加急</th>
                    <th scope="col">订单号</th>
                    <th scope="col">本地时间</th>
                  </tr>
                </thead>
                <tbody>
                  {group.normalRows.map((row) => (
                    <tr key={row.id} className={row.rush ? 'is-rush' : undefined}>
                      <td>{formatDailyItemSummary(row.items)}</td>
                      <td>{row.totalQty}</td>
                      <td>{row.marks || '—'}</td>
                      <td>{row.rush ? '★' : '—'}</td>
                      <td>{row.amazonOrderId || '—'}</td>
                      <td>{formatDailyTimeLabel(row.purchaseDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {group.yangRows.length > 0 ? (
            <section className="daily-print-color-section">
              <div className="daily-print-subtitle">阳</div>
              <table className="daily-print-table daily-print-table--compact">
                <thead>
                  <tr>
                    <th scope="col">尺寸</th>
                    <th scope="col">数量</th>
                    <th scope="col">标记</th>
                    <th scope="col">加急</th>
                    <th scope="col">订单号</th>
                    <th scope="col">本地时间</th>
                  </tr>
                </thead>
                <tbody>
                  {group.yangRows.map((row) => (
                    <tr key={row.id} className={row.rush ? 'is-rush' : undefined}>
                      <td>{formatDailyItemSummary(row.items)}</td>
                      <td>{row.totalQty}</td>
                      <td>{row.marks || '—'}</td>
                      <td>{row.rush ? '★' : '—'}</td>
                      <td>{row.amazonOrderId || '—'}</td>
                      <td>{formatDailyTimeLabel(row.purchaseDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function DailyOrderPrintView({
  rows,
  colorGroups,
  listMode,
}: DailyOrderPrintViewProps) {
  return (
    <div className="daily-print-root">
      {listMode === 'colors' ? renderColorGroups(colorGroups) : renderOrderRows(rows)}
    </div>
  );
}
