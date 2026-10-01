# 40 项验收台账

对应 [原始诊断](2026-10-01-project-diagnosis.md)，只记录当前证据与缺口，不替代原始验收要求。**本地通过**表示当前实现及相邻回归已覆盖本地范围，不代表生产或双平台完整验收；任何待远端、待平台或部分项都不能据此宣布整体完成。

| 编号 | 范围 | 状态 | 当前证据 / 剩余要求 |
|---|---|---|---|
| [01](2026-10-01-project-diagnosis.md#item-01) | 成员与邀请授权 | 待远端 | 原子 RPC、直接写入限制及隔离 SQL 测试已准备；授权迁移仍待明确批准。 |
| [02](2026-10-01-project-diagnosis.md#item-02) | 私有 Realtime 与身份 | 部分 | 已确认 key/metadata 不绑定身份；认证实例租约/RPC、伪造身份与旧版本拒绝已隔离验证，前端/会客厅已切换可信投影并通过伪造 payload、过期/迟到/限频回归；远端部署、真实 Realtime 和公共频道设置仍待完成。 |
| [03](2026-10-01-project-diagnosis.md#item-03) | 房间并发边界 | 本地通过 | roomManager 版本、串行队列、受控进入/退出/切房回归。 |
| [04](2026-10-01-project-diagnosis.md#item-04) | 注销与身份停止 | 本地通过 | stopPetApp 清身份、失效旧任务；账号变化关闭弹层，换肤通知校验归属。 |
| [05](2026-10-01-project-diagnosis.md#item-05) | 请求关联与取消 | 本地通过 | roomProtocol/windowRequest 的 ID、目标、超时和取消回归。 |
| [06](2026-10-01-project-diagnosis.md#item-06) | 桥接错误传播 | 本地通过 | 窗口命令/定向事件/拖动失败向调用者传播，日志不改变业务结果。 |
| [07](2026-10-01-project-diagnosis.md#item-07) | 远程窗口交错 | 本地通过 | remoteWindowQueue、实例令牌和延迟创建/销毁/重建回归。 |
| [08](2026-10-01-project-diagnosis.md#item-08) | 原生注册表清理 | 本地通过 | 销毁清 HitRegistry、父子偏移和实例表；Rust 与 macOS 原生回归。 |
| [09](2026-10-01-project-diagnosis.md#item-09) | 快照与实时消息 | 本地通过 | 订阅先就绪、历史合并、重连补查/去重及可取消重试。 |
| [10](2026-10-01-project-diagnosis.md#item-10) | 发送关联与重复提交 | 本地通过 | 消息请求关联、编辑器版本与在途禁用回归。 |
| [11](2026-10-01-project-diagnosis.md#item-11) | 异步监听释放 | 本地通过 | eventSubscription 监听就绪、迟到注册和取消回归。 |
| [12](2026-10-01-project-diagnosis.md#item-12) | 窗口就绪协议 | 本地通过 | windowReadiness 握手/实例/顺序快照，实际 webview 回执。 |
| [13](2026-10-01-project-diagnosis.md#item-13) | 连接就绪与失败 | 本地通过 | 持续连接状态、迟到 track 隔离、进入提交前再次同步与检查。 |
| [14](2026-10-01-project-diagnosis.md#item-14) | 本地退出与迟到写入 | 本地通过 | 立即失效本地房间；心跳与退出串行、HTTP 限时；失去成员资格的 RLS 收尾已补。 |
| [15](2026-10-01-project-diagnosis.md#item-15) | 显隐生命周期 | 本地通过 | roomVisibility 准备/显隐串行及失败回滚，自己窗口成组显隐。 |
| [16](2026-10-01-project-diagnosis.md#item-16) | 认证刷新重建 | 本地通过 | 同 Auth session 令牌刷新保留订阅，新 session 重建；恢复失败可重试，取消初始化不重置新房间。 |
| [17](2026-10-01-project-diagnosis.md#item-17) | 会客厅异步归属 | 本地通过 | 捕获账号/目标、refreshController、弹层实例与换肤账号队列回归。 |
| [18](2026-10-01-project-diagnosis.md#item-18) | 刷新风暴与租约 | 本地通过 | 刷新合并、可信在线快照过期、连接健康同步和暂停后补快照；兼容表心跳失败不阻断认证租约更新。 |
| [19](2026-10-01-project-diagnosis.md#item-19) | 通知资源调度 | 本地通过 | notificationScheduler 取消/上限/TTL，真实 toast 投递与销毁回归。 |
| [20](2026-10-01-project-diagnosis.md#item-20) | 显示器坐标与可用区 | 部分 | 实际父窗口选屏、工作区与实例校验已通过单元/原生回归，避免逻辑矩形重叠误选屏；混合 DPI 的全局坐标单位及实际双屏布局仍需统一/验收。 |
| [21](2026-10-01-project-diagnosis.md#item-21) | 原生命令实际完成 | 本地通过 | window_tasks 等待实际主线程结果和 Destroyed，实例防过期回归。 |
| [22](2026-10-01-project-diagnosis.md#item-22) | Windows 父子窗口 | 待平台 | owner 与跟随代码已补；Windows 实机验收缺失。 |
| [23](2026-10-01-project-diagnosis.md#item-23) | Windows 窗口权限 | 本地通过 | capability 与 AST 调用权限回归；真实 Windows 运行归入平台门禁。 |
| [24](2026-10-01-project-diagnosis.md#item-24) | 光标与拖动负载 | 本地通过 | 原生单次采样、成功缓存；共享点击/穿透掩模、失败重试与拖动态释放。 |
| [25](2026-10-01-project-diagnosis.md#item-25) | 原子建房 | 待远端 | create_room RPC 与本地事务测试通过；远端迁移待批准。 |
| [26](2026-10-01-project-diagnosis.md#item-26) | 数据库可重建 | 待远端 | 真实基线、历史归档与隔离重建通过；远端历史对齐待批准。 |
| [27](2026-10-01-project-diagnosis.md#item-27) | 查询索引 | 待远端 | 索引随授权迁移准备，本地验证通过；远端未应用。 |
| [28](2026-10-01-project-diagnosis.md#item-28) | 公开身份字段 | 待远端 | 字段权限/触发器与前端资源校验已补；远端授权迁移未应用。 |
| [29](2026-10-01-project-diagnosis.md#item-29) | 聊天完整游标与上限 | 本地通过 | 时间/ID 复合游标、快照合并与有界阅读窗口回归。 |
| [30](2026-10-01-project-diagnosis.md#item-30) | 偏好与皮肤作用域 | 本地通过 | 账号资料为皮肤事实源，设备偏好与账号/房间/发送者游标分离；无全局 skin 缓存写入。 |
| [31](2026-10-01-project-diagnosis.md#item-31) | 资源注册与缓存 | 本地通过 | 构建/验收共用实际注册器，保留别名、缺失文件、失败重试及图片回退回归。 |
| [32](2026-10-01-project-diagnosis.md#item-32) | 持久关联诊断 | 本地通过 | 固定字段本机日志、体积轮转、按需有界复制；原生落盘/读取与保留测试。 |
| [33](2026-10-01-project-diagnosis.md#item-33) | 模块与状态所有者 | 部分 | 数据/刷新/订阅会话/队列/请求/换肤控制器及共享依赖门禁已拆；会客厅剩余装配与全局副作用仍需核查。 |
| [34](2026-10-01-project-diagnosis.md#item-34) | 生命周期与平台门禁 | 待平台 | 受控时序、verify、原生回归和双平台 CI 已配置；远端 CI/Windows 实机证据缺失。 |
| [35](2026-10-01-project-diagnosis.md#item-35) | 遗留入口与文档 | 本地通过 | 删除独立 login 与假布局接口；更新 AGENTS、ADR 索引、当前架构和资源契约。 |
| [36](2026-10-01-project-diagnosis.md#item-36) | 窗口角色与契约 | 本地通过 | 原生命令按角色限制、实例校验、请求/结果与皮肤归属 DTO；诊断导出仅会客厅。 |
| [37](2026-10-01-project-diagnosis.md#item-37) | 弹层焦点与归属 | 本地通过 | 通用/聊天/换肤焦点管理、关闭失效、失败保留选择与账号切换释放。 |
| [38](2026-10-01-project-diagnosis.md#item-38) | 暂停、唤醒与退出 | 待平台 | 暂停释放、恢复资格复查、统一三秒退出及实际回执已补；真实双平台系统休眠验收缺失。 |
| [39](2026-10-01-project-diagnosis.md#item-39) | RPC 并发锁与幂等 | 待远端 | 房间锁和并发 SQL 回归已准备；远端未应用，真实双客户端验收待进行。 |
| [40](2026-10-01-project-diagnosis.md#item-40) | 可重复环境与工具 | 本地通过 | verify/平台构建、显式后端、认证隔离、独立 native 端口、统一资源注册器与工具依赖。 |

最新命令与数量见 [修复进度](repair-progress.md)。远端授权迁移/历史对齐被自动审批拒绝后未继续执行，需对具体变更明确批准；平台验收缺口需取得实际运行证据。下一步优先处理 02、20、33 的本地缺口，再完成远端和平台门禁。
