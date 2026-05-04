import type { ReactNode } from 'react';

type TableColumn<Row> = {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  editable?: boolean;
  inputType?: 'text' | 'number' | 'datetime-local';
  placeholder?: string;
  className?: string;
  getValue?: (row: Row) => string | number;
  helperText?: (row: Row) => string;
  render?: (row: Row) => ReactNode;
};

type DataTableProps<Row> = {
  rows: Row[];
  columns: TableColumn<Row>[];
  rowKey: (row: Row) => string;
  onEdit?: (row: Row, columnKey: string, nextValue: string) => void;
  emptyState: string;
  variant?: 'default' | 'maker';
};

function resolveValue<Row>(row: Row, column: TableColumn<Row>): string | number {
  if (column.getValue) {
    return column.getValue(row);
  }

  return String((row as Record<string, string | number | undefined>)[column.key] ?? '');
}

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  onEdit,
  emptyState,
  variant = 'default',
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return <div className="table-empty">{emptyState}</div>;
  }

  return (
    <div className={`table-wrap table-wrap--${variant}`}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.align ? `align-${column.align}` : undefined}
                scope="col"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => {
                const value = resolveValue(row, column);

                return (
                  <td
                    key={column.key}
                    className={[
                      column.align ? `align-${column.align}` : '',
                      column.className ?? '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {column.editable && onEdit ? (
                      <div className="cell-edit-wrap">
                        <input
                          type={column.inputType ?? 'text'}
                          value={String(value)}
                          onChange={(event) =>
                            onEdit(row, column.key, event.currentTarget.value)
                          }
                          placeholder={column.placeholder}
                        />
                        {column.helperText ? (
                          <span className="cell-helper">
                            {column.helperText(row)}
                          </span>
                        ) : null}
                      </div>
                    ) : column.render ? (
                      column.render(row)
                    ) : (
                      <span>{String(value || '—')}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type { TableColumn };
