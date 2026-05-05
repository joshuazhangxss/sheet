import { useRef, type ChangeEvent } from 'react';

import { DataTable, type TableColumn } from './DataTable';
import type { LabelMatch, LabelOrderReview } from '../types';

type LabelMatchPanelProps = {
  orderCount: number;
  labelPageCount: number;
  sourceCount: number;
  warnings: string[];
  matches: LabelMatch[];
  orderReviews: LabelOrderReview[];
  isUsingLabelOrders: boolean;
  onImport: (files: File[]) => void;
  onClear: () => void;
  onExportCsv: () => void;
  onExportBackPdf: () => void;
  isParsing: boolean;
};

function buildStatusLabel(status: LabelMatch['status']): string {
  if (status === 'matched') {
    return '已匹配';
  }

  if (status === 'possible') {
    return '待确认';
  }

  return '未匹配';
}

function buildStatusClass(status: LabelMatch['status']): string {
  if (status === 'matched') {
    return 'token token-good';
  }

  if (status === 'possible') {
    return 'token token-warn';
  }

  return 'token token-muted';
}

function renderSizeBreakdown(lines: string[]) {
  const safeLines = lines.filter((line) => line.trim());

  if (safeLines.length === 0) {
    return <strong>—</strong>;
  }

  return (
    <div className="label-size-list">
      {safeLines.map((line) => (
        <strong key={line}>{line}</strong>
      ))}
    </div>
  );
}

export function LabelMatchPanel({
  orderCount,
  labelPageCount,
  sourceCount,
  warnings,
  matches,
  orderReviews,
  isUsingLabelOrders,
  onImport,
  onClear,
  onExportCsv,
  onExportBackPdf,
  isParsing,
}: LabelMatchPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matchedCount = matches.filter((match) => match.status === 'matched').length;
  const possibleCount = matches.filter((match) => match.status === 'possible').length;
  const unmatchedCount = matches.filter((match) => match.status === 'unmatched').length;
  const duplicateCount = matches.filter((match) =>
    match.reasons.includes('重复订单'),
  ).length;

  const columns: TableColumn<LabelMatch>[] = [
    {
      key: 'labelPage',
      label: '标签页',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.sourceName}</strong>
          <span>第 {row.pageNumber} 页</span>
        </div>
      ),
    },
    {
      key: 'status',
      label: '状态',
      render: (row) => (
        <span className={buildStatusClass(row.status)}>{buildStatusLabel(row.status)}</span>
      ),
    },
    {
      key: 'amazonOrderId',
      label: '订单号',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.amazonOrderId || '—'}</strong>
          <span>{row.trackingNumber || row.postalCode || '没有附加识别字段'}</span>
        </div>
      ),
    },
    {
      key: 'color',
      label: '颜色',
      render: (row) => (
        <strong>{row.color || '—'}</strong>
      ),
    },
    {
      key: 'size',
      label: '尺寸',
      render: (row) => renderSizeBreakdown(row.sizeBreakdown),
    },
    {
      key: 'productType',
      label: '类型',
      render: (row) => (
        <strong>{row.productType || '—'}</strong>
      ),
    },
    {
      key: 'rush',
      label: '加急',
      render: (row) => (
        <strong>{row.note.includes('★') ? '★' : '—'}</strong>
      ),
    },
  ];

  const orderColumns: TableColumn<LabelOrderReview>[] = [
    {
      key: 'amazonOrderId',
      label: '订单号',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.amazonOrderId || '—'}</strong>
          <span>{row.matchedPages}</span>
        </div>
      ),
    },
    {
      key: 'recipientName',
      label: '姓名',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.recipientName || '—'}</strong>
          <span>
            {row.recipientName
              ? row.postalCode || row.cityState || '—'
              : '订单文件和标签页都没有可用姓名'}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      label: '状态',
      render: (row) => (
        <span className={buildStatusClass(row.status)}>{buildStatusLabel(row.status)}</span>
      ),
    },
    {
      key: 'production',
      label: '订单内容',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.color || '—'}</strong>
          {renderSizeBreakdown(row.sizeBreakdown)}
          <span>
            {[row.productType, `x${row.qty || 0}`, row.note].filter(Boolean).join(' · ') || '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'reasons',
      label: '核对说明',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.reasons.join(' / ') || '—'}</strong>
          <span>{row.trackingNumber || row.postalCode || row.cityState || '没有附加识别字段'}</span>
        </div>
      ),
    },
  ];

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    if (files.length === 0) {
      return;
    }

    onImport(files);
    event.currentTarget.value = '';
  }

  return (
    <section className="section-card">
      <div className="section-head">
        <div>
          <h2>标签批次</h2>
          <p className="section-text">
            上传 shipping label PDF。系统会先按每个 PDF 自己的顺序匹配，再自动生成这批生产单。
          </p>
        </div>
        <div className="section-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => inputRef.current?.click()}
            disabled={isParsing}
          >
            {isParsing ? '正在解析 PDF…' : '选择标签 PDF'}
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={onClear}
            disabled={labelPageCount === 0}
          >
            清空标签
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onExportBackPdf}
            disabled={matches.length === 0}
          >
            导出背面 PDF
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={handleInput}
        />
      </div>

      {isUsingLabelOrders ? (
        <div className="status-bar">这批标签已自动生成生产单。</div>
      ) : null}

      <div className="check-grid">
        <div className="check-card">
          <span className="check-label">订单库</span>
          <strong>{orderCount}</strong>
          <p>会在全部已导入订单里找标签对应的订单。</p>
        </div>
        <div className="check-card">
          <span className="check-label">标签页数</span>
          <strong>{labelPageCount}</strong>
          <p>来自 {sourceCount} 个 PDF 文件。</p>
        </div>
        <div className="check-card">
          <span className="check-label">已匹配</span>
          <strong>
            {matchedCount}
          </strong>
          <p>待确认 {possibleCount} 页，未匹配 {unmatchedCount} 页。</p>
        </div>
        <div className="check-card">
          <span className="check-label">提示</span>
          <strong>{warnings.length + duplicateCount}</strong>
          <p>图片标签页会优先按汇总页顺序匹配。</p>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="check-panel">
          <div className="check-panel-head">
            <h3>标签解析警告</h3>
            <span>{warnings.length}</span>
          </div>
          <ul className="warning-list">
            {warnings.slice(0, 6).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <DataTable
        rows={matches}
        columns={columns}
        rowKey={(row) => row.id}
        emptyState="请先上传标签 PDF，系统会在这里显示每一页标签和订单的匹配结果。"
      />

      <details className="advanced-panel">
        <summary className="details-summary">
          <span>按订单核对</span>
          <strong>{orderReviews.length}</strong>
        </summary>
        <div className="section-actions compact-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onExportCsv}
            disabled={matches.length === 0}
          >
            导出匹配 CSV
          </button>
        </div>
        <DataTable
          rows={orderReviews}
          columns={orderColumns}
          rowKey={(row) => row.id}
          emptyState="当前没有可核对的订单。"
        />
      </details>
    </section>
  );
}
