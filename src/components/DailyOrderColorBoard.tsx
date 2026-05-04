import type { DailyColorGroup, DailyOrderRow } from '../types';

type DailyOrderColorBoardProps = {
  groups: DailyColorGroup[];
  emptyState: string;
  onUpdateSize: (row: DailyOrderRow, nextValue: string) => void;
  onToggleRush: (row: DailyOrderRow) => void;
};

function formatDailyItemSummary(row: DailyOrderRow): string {
  return row.items
    .map((item) => (item.qty > 1 ? `${item.size} x${item.qty}` : item.size || '待确认'))
    .join('、');
}

function formatDailyTimeLabel(value: string): string {
  return value.replace('T', ' ');
}

function renderSection(
  title: string,
  rows: DailyOrderRow[],
  onUpdateSize: (row: DailyOrderRow, nextValue: string) => void,
  onToggleRush: (row: DailyOrderRow) => void,
) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="daily-color-subsection">
      <div className="daily-color-subtitle">{title}</div>
      <div className="daily-color-table-wrap">
        <table className="daily-color-table">
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
            {rows.map((row) => (
              <tr key={row.id} className={row.rush ? 'is-rush' : undefined}>
                <td>
                  {row.items.length === 1 ? (
                    <div className="daily-color-cell-stack">
                      <input
                        type="text"
                        className="daily-color-input"
                        value={row.items[0]?.size ?? ''}
                        placeholder="待确认"
                        onChange={(event) => onUpdateSize(row, event.currentTarget.value)}
                        aria-label={`${row.color || '待确认颜色'} ${row.amazonOrderId || ''} 的尺寸`}
                      />
                      <span className="cell-helper">直接修正生产尺寸</span>
                    </div>
                  ) : (
                    <div className="daily-color-cell-stack">
                      <strong className="daily-color-main">{formatDailyItemSummary(row)}</strong>
                      <span className="cell-helper">同单多尺寸请到总表修改</span>
                    </div>
                  )}
                </td>
                <td className="align-center">
                  <strong className="daily-color-main">{row.totalQty}</strong>
                </td>
                <td>
                  <strong className="daily-color-mark">{row.marks || '—'}</strong>
                </td>
                <td className="align-center">
                  <button
                    type="button"
                    className={`daily-rush-toggle ${row.rush ? 'is-active' : ''}`}
                    onClick={() => onToggleRush(row)}
                    aria-label={`${row.amazonOrderId || '当前订单'}${row.rush ? '取消加急' : '标记加急'}`}
                  >
                    {row.rush ? '★' : '—'}
                  </button>
                </td>
                <td>
                  <span className="daily-color-meta">{row.amazonOrderId || '—'}</span>
                </td>
                <td>
                  <span className="daily-color-meta">{formatDailyTimeLabel(row.purchaseDate)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DailyOrderColorBoard({
  groups,
  emptyState,
  onUpdateSize,
  onToggleRush,
}: DailyOrderColorBoardProps) {
  if (groups.length === 0) {
    return <div className="table-empty">{emptyState}</div>;
  }

  return (
    <div className="daily-color-board">
      {groups.map((group) => (
        <section key={group.color} className="daily-color-group">
          <header className="daily-color-group-header">
            <div>
              <span className="daily-color-kicker">颜色</span>
              <h3>{group.color}</h3>
            </div>
            <strong>{group.totalQty}</strong>
          </header>

          {renderSection('常规', group.normalRows, onUpdateSize, onToggleRush)}
          {renderSection('阳', group.yangRows, onUpdateSize, onToggleRush)}
        </section>
      ))}
    </div>
  );
}
