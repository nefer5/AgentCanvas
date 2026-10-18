import {renderToStaticMarkup} from 'react-dom/server'
import {describe,it,expect} from 'vitest'
import {EmbeddedPanel,submissionLabel,type HostBoard} from './EmbeddedPanel'
const board:HostBoard={boardId:'board-a',sessionId:'session-a',revision:4,scene:null,host:{name:'DSH',workspaceRoot:'E:/课题 A',workspaceName:'课题 A'},submissions:[{id:'canvas-one',revision:3,note:'说明',status:'answered'}]}
const noop=()=>{}
const render=(overrides={})=>renderToStaticMarkup(<EmbeddedPanel board={board} scene={null} revision={4} note="未发送的说明" busy={false} status="画板已保存" error="" connected onNote={noop} onSubmit={noop} onCheck={noop} onSave={noop} onExport={noop} onSnapshot={noop} onComplete={noop} {...overrides}/> )
describe('共享右栏的DSH宿主适配',()=>{
 it('保留公共右栏、真实课题及绑定，连接不冒充Agent等待',()=>{const html=render();expect(html).toContain('agent-panel');expect(html).toContain('E:/课题 A');expect(html).toContain('画面概览');expect(html).toContain('连接与可靠性');expect(html).toContain('DSH · 会话 '+board.sessionId.slice(-8));expect(html).not.toContain('Agent 正在等待');expect(html).not.toContain('进入待处理箱')})
 it('历史只读和忙状态禁止提交，说明仍保留',()=>{const html=render({board:{...board,readOnly:true}});expect(html).toMatch(/agent-panel__submit[^>]*disabled/);expect(html).toContain('未发送的说明');expect(html).toContain('本会话提交记录')})
 it('失联和不确定交付使用DSH语义，不误报已处理',()=>{const html=render({connected:false,board:{...board,submissions:[{id:'one',status:'uncertain',revision:1,note:''}]}});expect(html).toContain('连接待恢复');expect(html).toContain('不会自动重发');expect(html).not.toContain('已发送，Agent 正在处理');expect(submissionLabel('processed')).toBe('已确认处理')})
})