import type { ReactNode } from 'react'
import { InterfaceIcon } from './InterfaceIcon'

// 两种宿主复用同一诊断外观，数据和动作由各自适配器提供。
export function ConnectionDetails({service, healthy, rows, children}: {
  service: string; healthy: boolean; rows: {label:string; value:ReactNode}[]; children?:ReactNode
}) {
  return <details className="reliability-panel">
    <summary><span className="reliability-title"><InterfaceIcon name="shield" />连接与可靠性</span> <span className={healthy?'status-ok':'status-warn'}>{service}</span></summary>
    <dl>{rows.map(row=><div className="reliability-row" key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    {children}
  </details>
}
