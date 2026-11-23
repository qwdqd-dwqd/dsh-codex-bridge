window.__ModuleLoader__.load({
  id: 'dsh-codex-bridge',
  factory(require) {
    const { createElement: h, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } = require('react')
    const kind = 'codex-history'
    const id = 'dsh-codex-bridge'
    const listSize = 50
    const messagePageSize = 100
    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
      },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '6px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l3, #ccc)',
      },
      body: { flex: 1, overflow: 'auto', overflowAnchor: 'none', padding: '8px 12px', overflowWrap: 'anywhere' },
      button: {
        minHeight: 44, padding: '6px 10px', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
        color: 'inherit', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l3, #ccc)', borderRadius: 8,
      },
      card: { display: 'block', width: '100%', marginBottom: 8, textAlign: 'start' },
      title: { flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
      preview: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' },
      group: { fontSize: '0.9rem', margin: '10px 0 6px' },
      meta: { fontSize: '0.8rem', opacity: 0.75, marginTop: 4 },
      composer: { padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l3, #ccc)', flexShrink: 0 },
      input: {
        boxSizing: 'border-box', display: 'block', width: '100%', minHeight: 58, resize: 'vertical',
        font: 'inherit', color: 'inherit', background: 'transparent', padding: 8,
        border: '1px solid var(--dsw-alias-border-l3, #ccc)', borderRadius: 8,
      },
      actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 },
      answer: { maxHeight: '26vh', overflow: 'auto', overflowWrap: 'anywhere' },
      text: { whiteSpace: 'pre-wrap', margin: '4px 0 16px', lineHeight: 1.55 },
    }
    const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    const titleOf = thread => thread.firstMessage || '无文字内容'

    async function call(connection, payload, signal) {
      const response = await connection.rpc.call('/api', 'codex-bridge/history', payload, signal)
      if (!response.ok || response.value?.error) {
        throw new Error(response.error?.message || response.value?.error || '侧栏请求失败')
      }
      return response.value
    }

    function makeJobId() {
      const hex = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    }

    function TaskComposer({ connection, thread, onComplete, restarting, onBusyChange }) {
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)
      const [job, setJob] = useState(null)
      const [pollCycle, setPollCycle] = useState(0)
      const [sendError, setSendError] = useState(null)
      const [pollError, setPollError] = useState(null)
      const request = useRef(null)
      const previousJob = useRef(null)
      const retryJob = useRef(null)
      const submittedJob = useRef(null)
      const threadId = thread.id

      useEffect(() => {
        const controller = new AbortController()
        let timer
        async function poll() {
          try {
            const { job: latest } = await call(connection, { operation: 'status', thread: threadId }, controller.signal)
            if (controller.signal.aborted) return
            setPollError(null)
            setJob(latest)
            const previous = previousJob.current
            previousJob.current = latest
            if (latest?.state === 'running') timer = setTimeout(poll, 3000)
            if (latest?.state === 'done' && previous?.id === latest.id && previous.state === 'running') onComplete()
            const submitted = submittedJob.current
            if (submitted && latest?.id === submitted.id && latest.state !== 'running') {
              if (latest.state === 'failed') setDraft(value => value || submitted.message)
              submittedJob.current = null
            }
          } catch {
            if (controller.signal.aborted) return
            setPollError('连接暂时中断，正在重新查询任务状态。')
            timer = setTimeout(poll, 5000)
          }
        }
        void poll()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [connection, threadId, onComplete, pollCycle])

      useEffect(() => () => request.current?.abort(), [])

      async function send(event) {
        event.preventDefault()
        if (request.current || restarting || job?.state === 'running' || !draft.trim()) return
        const controller = new AbortController()
        request.current = controller
        setSending(true)
        setSendError(null)
        const message = draft.trim()
        const jobId = retryJob.current?.message === message ? retryJob.current.id : makeJobId()
        retryJob.current = { id: jobId, message }
        try {
          let accepted
          try {
            accepted = (await call(connection, {
              operation: 'send', thread: threadId, jobId, message,
            }, controller.signal)).job
          } catch (error) {
            if (controller.signal.aborted) return
            const status = await call(connection, { operation: 'status', thread: threadId }, controller.signal)
              .catch(() => null)
            if (status?.job?.id !== jobId) throw error
            accepted = status.job
          }
          if (controller.signal.aborted) return
          submittedJob.current = { id: accepted.id, message }
          previousJob.current = { id: accepted.id, state: 'running' }
          setJob(accepted)
          retryJob.current = null
          setDraft('')
        } catch (error) {
          if (!controller.signal.aborted) setSendError(error.message)
        } finally {
          request.current = null
          if (!controller.signal.aborted) {
            setSending(false)
            setPollCycle(value => value + 1)
          }
        }
      }

      const pending = sending || job?.state === 'running'
      const seconds = job?.state === 'running' && Number.isFinite(job.startedAt)
        ? Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000))
        : null
      const elapsed = seconds === null ? '' : seconds < 60
        ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      useEffect(() => {
        onBusyChange(pending)
        return () => onBusyChange(false)
      }, [pending, onBusyChange])

      return h('form', { style: styles.composer, onSubmit: send },
        pollError && h('p', { role: 'status', style: styles.meta }, pollError),
        sendError && h('p', { role: 'alert', style: styles.meta }, sendError),
        job?.state === 'failed' && h('p', { role: 'alert', style: styles.meta }, job.message),
        job?.state === 'done' && h('details', { key: job.id, open: true, style: styles.answer },
          h('summary', null, 'Codex 最近回复'),
          h('div', { style: styles.text }, job.answer),
        ),
        h('textarea', {
          style: styles.input, value: draft, maxLength: 16000, disabled: pending, rows: 2,
          'aria-label': '发给当前 Codex 会话的任务', placeholder: '输入要 Codex 继续做的任务…',
          onChange: event => setDraft(event.target.value),
        }),
        h('div', { style: styles.actions },
          h('div', { style: styles.meta },
            h('span', { role: 'status' }, sending ? '正在提交…' : job?.state === 'running' ? 'Codex 正在执行。' : ''),
            elapsed && h('span', { 'aria-live': 'off' }, ` 已等待 ${elapsed}。`),
            seconds >= 30 && h('div', null, '长会话可能需要更久，可以稍后回来查看。'),
          ),
          h('button', { type: 'submit', style: styles.button, disabled: restarting || pending || !draft.trim() }, '发送任务'),
        ),
      )
    }

    function useRestartControl(connection) {
      const [status, setStatus] = useState(null)
      const [checking, setChecking] = useState(false)
      const [error, setError] = useState(null)
      const [cycle, setCycle] = useState(0)
      const request = useRef(null)
      const retryId = useRef(null)

      useEffect(() => {
        const controller = new AbortController()
        let timer
        async function poll() {
          try {
            const value = await call(connection, { operation: 'restart-status' }, controller.signal)
            if (controller.signal.aborted) return
            if (value.job?.id === retryId.current) retryId.current = null
            setStatus(value)
            if (value.tasksBusy || value.job?.state === 'running') timer = setTimeout(poll, 2000)
          } catch {
            if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
          }
        }
        void poll()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [connection, cycle])

      useEffect(() => () => request.current?.abort(), [])

      async function restart() {
        if (request.current || status?.tasksBusy || status?.job?.state === 'running') return
        const controller = new AbortController()
        request.current = controller
        const jobId = retryId.current || makeJobId()
        retryId.current = jobId
        setChecking(true)
        setError(null)
        try {
          const value = await call(connection, { operation: 'restart', jobId }, controller.signal)
          if (!controller.signal.aborted) {
            retryId.current = null
            setStatus(value)
          }
        } catch (failure) {
          if (!controller.signal.aborted) setError(failure.message)
        } finally {
          request.current = null
          if (!controller.signal.aborted) {
            setChecking(false)
            setCycle(value => value + 1)
          }
        }
      }

      return { status, checking, error, restart }
    }

    function CodexPanel({ connection }) {
      const [thread, setThread] = useState(null)
      const [limit, setLimit] = useState(listSize)
      const [revision, setRevision] = useState(0)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [confirmRestart, setConfirmRestart] = useState(false)
      const [taskPending, setTaskPending] = useState(false)
      const { status: restartStatus, checking: restartingRequest, error: restartError, restart } = useRestartControl(connection)
      const restartJob = restartStatus?.job
      const restarting = restartingRequest || restartJob?.state === 'running'
      const restartDisabled = restarting || taskPending || !restartStatus || restartStatus.tasksBusy
      const threadId = thread?.id
      const historyBody = useRef(null)
      const scrollIntent = useRef(null)
      const refresh = useCallback(() => {
        scrollIntent.current = { bottomGap: 0 }
        setRevision(value => value + 1)
      }, [])

      useLayoutEffect(() => {
        const body = historyBody.current
        const intent = scrollIntent.current
        if (!body || !intent || !threadId || result?.thread !== threadId) return
        body.scrollTop = body.scrollHeight - body.clientHeight - intent.bottomGap
        scrollIntent.current = null
      }, [result, threadId])

      useEffect(() => {
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        const payload = threadId
          ? { operation: 'read', thread: threadId, limit }
          : { operation: 'list', limit }
        call(connection, payload, controller.signal)
          .then(value => {
            if (!controller.signal.aborted) setResult(value)
          })
          .catch(failure => {
            if (!controller.signal.aborted) setError(failure.message)
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
        return () => controller.abort()
      }, [connection, threadId, limit, revision])

      function navigate(nextThread) {
        scrollIntent.current = nextThread ? { bottomGap: 0 } : null
        if (historyBody.current) historyBody.current.scrollTop = 0
        setThread(nextThread)
        setLimit(nextThread ? messagePageSize : listSize)
        setResult(null)
        setError(null)
        setLoading(true)
      }

      function showEarlierMessages() {
        const body = historyBody.current
        if (body) scrollIntent.current = {
          bottomGap: body.scrollHeight - body.clientHeight - body.scrollTop,
        }
        setLimit(value => value + messagePageSize)
      }

      function button(label, onClick, extra = {}) {
        return h('button', { type: 'button', style: styles.button, onClick, ...extra }, label)
      }

      const messages = result?.messages || []
      return h('section', { style: styles.root, 'aria-label': 'Codex 会话' },
        h('header', { style: styles.toolbar },
          thread && button('返回', () => navigate(null)),
          h('strong', { style: styles.title, title: thread ? titleOf(thread) : undefined },
            thread ? titleOf(thread) : 'Codex 会话'),
          button('刷新', refresh, { disabled: loading }),
          button('重启 Codex', () => setConfirmRestart(true), { disabled: restartDisabled }),
        ),
        confirmRestart && h('div', { style: styles.composer, role: 'group', 'aria-label': '确认重启 Codex' },
          h('div', null, '请先结束 Codex 桌面端正在运行的任务并保存草稿。重启期间可继续使用 DSH。'),
          h('div', { style: styles.actions },
            button('取消', () => setConfirmRestart(false)),
            button('确认重启', () => {
              setConfirmRestart(false)
              void restart()
            }, { disabled: restartDisabled }),
          ),
        ),
        (restarting || restartError || restartJob?.message) && h('div', {
          style: styles.composer, role: restartError || restartJob?.state === 'failed' ? 'alert' : 'status',
        }, restarting ? '正在重启 Codex 桌面端…' : restartError || restartJob.message),
        h('div', { ref: historyBody, style: styles.body, 'aria-busy': loading },
          error && h('p', { role: 'alert' }, error),
          loading && !result && h('p', { role: 'status' }, '正在读取…'),
          result && (thread
            ? h('div', { key: threadId },
              result.model && h('p', { style: styles.meta }, result.model),
              messages.length >= limit && limit < 500 &&
                button('显示更早的消息', showEarlierMessages, { disabled: loading }),
              messages.length === 0 && h('p', null, '这个会话还没有可显示的消息。'),
              messages.map((message, index) => h('article', { key: index },
                h('strong', null, { user: '你', codex: 'Codex', command: '命令' }[message.role]),
                h('div', { style: styles.text }, message.text),
              )),
            )
            : h('div', null,
              result.total === 0 && h('p', null, '没有找到 Codex 会话。'),
              result.groups.map(group => h('section', { key: group.cwd || '' },
                h('h3', { style: styles.group }, group.project, ' · ', group.count),
                group.threads.map(item => button(
                  h(Fragment, null, h('span', { style: styles.preview }, titleOf(item)),
                    h('div', { style: styles.meta }, item.turns, ' 轮',
                      item.last ? ' · ' + dateFormat.format(item.last * 1000) : ''),
                  ),
                  () => navigate(item),
                  { key: item.id, style: { ...styles.button, ...styles.card } },
                )),
              )),
              result.total >= limit && limit < 500 &&
                button('显示更多会话', () => setLimit(value => value + listSize), { disabled: loading }),
            )),
        ),
        thread && h(TaskComposer, { key: threadId, connection, thread, onComplete: refresh, restarting, onBusyChange: setTaskPending }),
      )
    }

    return {
      inject: ['connection', 'slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind, title: () => 'Codex',
          guide: [{
            id: 'history', order: 45, title: () => 'Codex 会话',
            description: () => '查看历史并向指定会话发送任务',
          }],
        }), 'codex-bridge: sidebar tab')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: id,
        }, () => h(CodexPanel, { connection: ctx.connection }))), 'codex-bridge: sidebar body')
      },
    }
  },
})
