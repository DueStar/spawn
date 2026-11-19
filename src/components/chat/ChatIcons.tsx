/**
 * The chat view's icons: the app's one icon system (src/components/Icons.tsx — Phosphor, bold, 16 / 14 / 12),
 * currentColor, so they take the row's grey. Decorative: every one is aria-hidden; the words beside them carry the
 * meaning. (Until 2026-11-17 the chat drew its own at stroke 1.4, thinner than the rest of the app.)
 */

import React from 'react'
// (one module per icon: the whole set is 3000+ icons, which a test or a build should never load)
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown'
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp'
import { AtIcon as At } from '@phosphor-icons/react/dist/csr/At'
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown'
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight'
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle'
import { ClipboardTextIcon as ClipboardText } from '@phosphor-icons/react/dist/csr/ClipboardText'
import { CpuIcon as Cpu } from '@phosphor-icons/react/dist/csr/Cpu'
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye'
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File'
import { FilesIcon as Files } from '@phosphor-icons/react/dist/csr/Files'
import { GlobeIcon as Globe } from '@phosphor-icons/react/dist/csr/Globe'
import { LightbulbIcon as Lightbulb } from '@phosphor-icons/react/dist/csr/Lightbulb'
import { ListChecksIcon as ListChecks } from '@phosphor-icons/react/dist/csr/ListChecks'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple'
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { QuestionIcon as Question } from '@phosphor-icons/react/dist/csr/Question'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck'
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow'
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/dist/csr/TreeStructure'
import { WarningIcon as Warning } from '@phosphor-icons/react/dist/csr/Warning'
import { WrenchIcon as Wrench } from '@phosphor-icons/react/dist/csr/Wrench'
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X'
import type { ToolIcon as ToolIconName } from '../../chat/toolLabel'
import { ICON_SIZES, ph } from '../Icons'

type P = { size?: number }
const { button: B, inline: I, small: S } = ICON_SIZES

export const ChevIcon = ph(CaretRight, S)
export const FileIcon = ph(File, I)
export const FilesIcon = ph(Files, I)
export const SearchIcon = ph(MagnifyingGlass, I)
export const RunIcon = ph(TerminalWindow, I)
export const EditIcon = ph(PencilSimple, I)
export const AgentIcon = ph(TreeStructure, I)
export const WebIcon = ph(Globe, I)
export const TodoIcon = ph(ListChecks, I)
export const QuestionIcon = ph(Question, I)
export const PlanIcon = ph(ClipboardText, I)
export const ToolIcon = ph(Wrench, I)
export const ChatIcon = ph(ChatCircle, I)
export const WarnIcon = ph(Warning, B)
export const DownIcon = ph(ArrowDown, S)
// the density menu
export const EyeIcon = ph(Eye, I)
export const ChevDownIcon = ph(CaretDown, S)
// the composer: send, attach, mention, a chip's ×, the control row's model, effort and mode
export const SendUpIcon = ph(ArrowUp, B)
export const PlusIcon = ph(Plus, B)
export const AtIcon = ph(At, B)
export const XIcon = ph(X, S)
export const CpuIcon = ph(Cpu, I)
export const ShieldIcon = ph(ShieldCheck, I)
export const EffortIcon = ph(Lightbulb, I)

const BY_NAME: Record<ToolIconName, React.FC<P>> = {
  file: FileIcon, search: SearchIcon, run: RunIcon, edit: EditIcon, agent: AgentIcon, web: WebIcon,
  todo: TodoIcon, question: QuestionIcon, plan: PlanIcon, tool: ToolIcon,
}
export const ToolGlyph = ({ icon, size = I }: { icon: ToolIconName; size?: number }) => { const G = BY_NAME[icon]; return <G size={size} /> }
