import {
  hasRushNote,
  isPrivacyFenceType,
  stripRushNote,
} from '../lib/orderProcessing';
import type { MakerColorGroup, MakerRow } from '../types';

type MakerSheetBoardProps = {
  groups: MakerColorGroup[];
  emptyState: string;
  onEdit: (row: MakerRow, field: 'size' | 'productType' | 'note', nextValue: string) => void;
};

function renderWorkerMark(row: MakerRow): string {
  const mark = stripRushNote(row.note);

  if (mark) {
    return mark;
  }

  if (isPrivacyFenceType(row.productType)) {
    return '阳';
  }

  return row.productType || '—';
}

function renderSection(
  title: string,
  rows: MakerRow[],
  onEdit: (row: MakerRow, field: 'size' | 'productType' | 'note', nextValue: string) => void,
) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="maker-subsection">
      <div className="maker-subsection-title">{title}</div>
      <div className="maker-group-table-wrap">
        <table className="maker-group-table">
          <thead>
            <tr>
              <th scope="col">尺寸</th>
              <th scope="col">数量</th>
              <th scope="col">标记</th>
              <th scope="col">加急</th>
              <th scope="col">边型</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={hasRushNote(row.note) ? 'is-rush' : undefined}>
                <td>
                  <input
                    type="text"
                    className="maker-text-input maker-text-input--size"
                    value={row.size}
                    placeholder="待确认"
                    onChange={(event) => onEdit(row, 'size', event.currentTarget.value)}
                  />
                </td>
                <td className="maker-qty-cell">
                  <strong className="maker-qty-value">{row.qty}</strong>
                </td>
                <td>
                  <div className="maker-mark-cell">
                    <strong className="maker-mark-preview">{renderWorkerMark(row)}</strong>
                    <input
                      type="text"
                      className="maker-text-input maker-text-input--mark"
                      value={stripRushNote(row.note)}
                      placeholder={renderWorkerMark(row) === '—' ? '直 / 直+环' : renderWorkerMark(row)}
                      onChange={(event) => onEdit(row, 'note', event.currentTarget.value)}
                      aria-label={`${row.color} ${row.size} 的标记`}
                    />
                  </div>
                </td>
                <td>
                  <span
                    className={`maker-rush-flag ${hasRushNote(row.note) ? 'is-active' : ''}`}
                  >
                    {hasRushNote(row.note) ? '★' : ' '}
                  </span>
                </td>
                <td>
                  <input
                    type="text"
                    className="maker-text-input maker-text-input--type"
                    value={row.productType}
                    placeholder="边型"
                    onChange={(event) => onEdit(row, 'productType', event.currentTarget.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function MakerSheetBoard({
  groups,
  emptyState,
  onEdit,
}: MakerSheetBoardProps) {
  if (groups.length === 0) {
    return <div className="table-empty">{emptyState}</div>;
  }

  return (
    <>
      <div className="maker-board">
        {groups.map((group) => {
          const regularRows = group.rows.filter((row) => !isPrivacyFenceType(row.productType));

          if (regularRows.length === 0) {
            return null;
          }

          return (
            <section key={group.color} className="maker-group">
              <header className="maker-group-header">
                <div>
                  <span className="maker-group-kicker">颜色</span>
                  <h3>{group.color}</h3>
                </div>
                <strong>{regularRows.reduce((sum, row) => sum + row.qty, 0)}</strong>
              </header>

              {renderSection('常规', regularRows, onEdit)}
            </section>
          );
        })}
      </div>

      {groups.some((group) => group.rows.some((row) => isPrivacyFenceType(row.productType))) ? (
        <section className="maker-yang-panel">
          <div className="maker-yang-panel-head">
            <div>
              <span className="maker-group-kicker">阳区</span>
              <h3>不同颜色阳单</h3>
            </div>
          </div>

          <div className="maker-yang-board">
            {groups.map((group) => {
              const privacyRows = group.rows.filter((row) => isPrivacyFenceType(row.productType));

              if (privacyRows.length === 0) {
                return null;
              }

              return (
                <section key={`${group.color}-yang`} className="maker-yang-group">
                  <header className="maker-group-header maker-group-header--yang">
                    <div>
                      <span className="maker-group-kicker">颜色</span>
                      <h3>{group.color}（阳）</h3>
                    </div>
                    <strong>{privacyRows.reduce((sum, row) => sum + row.qty, 0)}</strong>
                  </header>

                  {renderSection('阳', privacyRows, onEdit)}
                </section>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}
