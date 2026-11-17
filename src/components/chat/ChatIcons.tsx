/**
 * The chat view's small line icons (stroke = currentColor, so they take the row's grey).
 * Decorative: every one is aria-hidden; the words beside them carry the meaning.
 */

import React from 'react'
import type { ToolIcon as ToolIconName } from '../../chat/toolLabel'

type P = { size?: number }
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
)

export const ChevIcon = ({ size = 12 }: P) => svg(size, <path d="M6 3.5 10.5 8 6 12.5" />)
export const FileIcon = ({ size = 14 }: P) => svg(size, <><path d="M4 1.5h5l3.5 3.5v9.5h-8.5z" /><path d="M9 1.5v3.5h3.5" /></>)
export const FilesIcon = ({ size = 14 }: P) => svg(size, <><path d="M5.5 3.5h4l3 3v7.5h-7z" /><path d="M3.5 12V1.5h5" /></>)
export const SearchIcon = ({ size = 14 }: P) => svg(size, <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>)
export const RunIcon = ({ size = 14 }: P) => svg(size, <><path d="m3 4.5 3.5 3.5L3 11.5" /><path d="M8.5 12h5" /></>)
export const EditIcon = ({ size = 14 }: P) => svg(size, <><path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" /></>)
export const AgentIcon = ({ size = 14 }: P) => svg(size, <><circle cx="5" cy="5" r="2.2" /><circle cx="11" cy="11" r="2.2" /><path d="M6.5 6.5 9.5 9.5" /></>)
export const WebIcon = ({ size = 14 }: P) => svg(size, <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>)
export const TodoIcon = ({ size = 14 }: P) => svg(size, <><path d="M6.5 4h7M6.5 8h7M6.5 12h7" /><path d="m2 4 1 1 2-2M2 8l1 1 2-2" /></>)
export const QuestionIcon = ({ size = 14 }: P) => svg(size, <><circle cx="8" cy="8" r="6" /><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" /><path d="M8 11.6v.1" /></>)
export const PlanIcon = ({ size = 14 }: P) => svg(size, <><rect x="3" y="2" width="10" height="12" rx="1.5" /><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" /></>)
export const ToolIcon = ({ size = 14 }: P) => svg(size, <><path d="M10 2.5a3 3 0 0 0-3.2 4L2.5 10.8l2.7 2.7 4.3-4.3a3 3 0 0 0 4-3.2l-1.8 1.8-1.9-.6-.6-1.9z" /></>)
export const ChatIcon = ({ size = 13 }: P) => svg(size, <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />)
export const WarnIcon = ({ size = 15 }: P) => svg(size, <><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3.2M8 11.6v.1" /></>)
export const DownIcon = ({ size = 12 }: P) => svg(size, <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />)
// the density menu (the lab's eye and chevD)
export const EyeIcon = ({ size = 14 }: P) => svg(size, <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>)
export const ChevDownIcon = ({ size = 12 }: P) => svg(size, <path d="M4 6l4 4 4-4" />)
// the composer (the lab's send, plus, x, cpu, shield)
export const SendUpIcon = ({ size = 15 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" /></svg>
)
export const PlusIcon = ({ size = 15 }: P) => svg(size, <path d="M8 3v10M3 8h10" />)
// the file mention: drawn on the same 16 grid as the plus, so the two sit at one height (a mono "@" glyph sat low)
export const AtIcon = ({ size = 15 }: P) => svg(size, <><circle cx="8" cy="8" r="2.6" /><path d="M10.6 5.6v3.3c0 1.2.8 1.9 1.7 1.9s1.7-.9 1.7-2.8a6 6 0 1 0-2.4 4.8" /></>)
export const XIcon =({ size = 11 }: P) => svg(size, <path d="M4 4l8 8M12 4l-8 8" />)
export const CpuIcon = ({ size = 13 }: P) => svg(size, <><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6.5 1.8v2M9.5 1.8v2M6.5 12.2v2M9.5 12.2v2M1.8 6.5h2M1.8 9.5h2M12.2 6.5h2M12.2 9.5h2" /></>)
export const ShieldIcon = ({ size = 13 }: P) => svg(size, <path d="M8 1.8 13 3.5v4c0 3.2-2.2 5.3-5 6.7-2.8-1.4-5-3.5-5-6.7v-4z" />)

const BY_NAME: Record<ToolIconName, (p: P) => React.ReactElement> = {
  file: FileIcon, search: SearchIcon, run: RunIcon, edit: EditIcon, agent: AgentIcon, web: WebIcon,
  todo: TodoIcon, question: QuestionIcon, plan: PlanIcon, tool: ToolIcon,
}
export const ToolGlyph = ({ icon, size = 14 }: { icon: ToolIconName; size?: number }) => BY_NAME[icon]({ size })
