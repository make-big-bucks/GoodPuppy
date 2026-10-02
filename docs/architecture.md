# 当前架构

这是现状索引；技术决策及演进背景保留在 [ADR](adr/README.md)，修复状态见 [修复进度](reviews/repair-progress.md)。前端采用原生 TypeScript，Rust 只负责系统与窗口能力。

## 窗口与所有者

| 窗口 | 入口 | 职责 |
|---|---|---|
| `main` / `pet-*` | `windows/pet.html` → `src/windows/pet/main.ts` | main 协调房间、网络、布局与远程窗口；远程 pet 只呈现状态与互动 |
| `bubble-self` / `bubble-*` | `windows/bubble.html` → `bubbleMain.ts` | 消息堆叠、编辑器与命中区域 |
| `lounge` | `windows/lounge.html` → `lounge-main.ts` | 登录、账号、房间、邀请、设置与聊天记录 |
| `toast-*` | `windows/toast.html` | 有界、可取消的上线提醒 |

独立登录窗口已移除；登录统一在会客厅弹层中完成。跨窗口通过事件协议协作，不共享可变的模块状态。资源目录、布局、偏好、头像组件和事件契约统一放在 `src/shared/pet/`；窗口之间禁止直接导入，共享层禁止依赖窗口。`check:dependencies` 随 verify/CI 执行。

## 关键边界

- 主窗口与会客厅入口使用 `resourceLifetime.ts` 统一释放事件、认证订阅和恢复监测；主窗口卸载后丢弃迟到的登录恢复与操作回复，会客厅卸载使资料操作与全部弹层失效，单项清理失败不阻断其它资源释放。
- 房间与身份由 `roomManager.ts` 管理，操作串行并带版本；退出立即使旧回调失效。`roomVisibility.ts` 按实际房间决定自己窗口显隐。
- `roomCoordinator.ts` 管理远程窗口，`petAutoLayout.ts` 纯计算自动/存档位置，房间与布局版本仍有效才清理屏外存档，`roomMessageCache.ts` 独占消息去重、完整游标排序和历史/实时统一上限，`windowReadiness.ts` 绑定实例，`presenterDelivery.ts` 独占顺序投递并在发送前复查房间代次与窗口实例；`windowRequest.ts` 管理请求 ID、取消与回执；`roomState.ts` 定义账号/控制器/版本快照，`roomStateSync.ts` 独占会客厅快照、版本和交错查询；打开记录前等待主窗口状态并刷新可访问房间。
- `petPresenter.ts` 管理 DOM、拖动、动画暂停与监听释放，`petState.ts` 管理动画分层。`hitTesting.ts` 生成掩模，Rust `cursor.rs` / `hit_test.rs` 独占鼠标穿透。
- 消息、Presence、互动订阅在各自模块中实现，`realtimeSubscription.ts` 持续观察就绪状态；身份/状态读取认证实例租约快照，广播只作为刷新提示；重连补快照，房间租约跟随连接健康状态。
- 会客厅入口只装配 SDK、事件与控制器；`lounge.ts` 独占界面投影（账号资料、房间选择、邀请列表）和通用弹层 DOM，账号/客户端切换同步失效旧操作并关闭聊天/设置/换肤界面。数据读取在 `loungeData.ts`，刷新合并在 `refreshController.ts`，房间进出在途状态由 `roomTransitions.ts` 独占，`roomCommandClient.ts` 验证回执/快照后触发窗口动作，窗口外观与手势由 `loungeChrome.ts` 管理，静态/动态拖动区域统一走一次 pointerdown，`authFlow.ts` 管理认证流程，登录/注册/领养/注销/绑定共用跨弹层在途门禁，`loungeSubscriptions.ts` 独占会话频道、重连刷新和释放，弹层操作在 `operationLifetime.ts` 校验实例，`loungeMutations.ts` 独占房间/邀请/资料数据操作，固定账号/目标并校验回执；调用端在 await 返回后再次校验身份，再更新界面。`skinSelection.ts` 独占换肤选择与账号写入队列，面板实例与已提交资料回执分开，皮肤通知带账号归属并以资料快照校准。长期聊天记录使用复合游标和有界缓存。
- 账号皮肤保存在 profiles；大小、模式与窗口位置是设备偏好；气泡关闭游标按账号、房间与发送者隔离。资源从 `public/pets/*/pet.json` 通过 `tools/petRegistry.mjs` 自动注册并在构建时检查。
- Rust `commands.rs` 校验窗口角色、实例与几何，`window_tasks.rs` 等待实际原生结果，`quit.rs` 统一限时退出握手。布局从主线程几何快照读取，`bubbles.rs` 按平台桌面单位维护实际父子偏移；位置使用平台桌面单位、内容尺寸保留逻辑单位，换算与验收见 [坐标契约](reviews/coordinate-contract.md)。

环境由 `backendConfig.ts` 统一解析，覆盖必须显式选择环境；生产保留既有认证键，开发/测试使用独立键。原生回归独占 1422 端口与测试后端，配置校验在打包前执行。

诊断由 `diagnostics.ts` 记录固定生命周期字段，Rust `diagnostics.rs` 负责有界日志与仅会客厅可调用的按需读取；原始 Error/消息正文不会传入日志接口。

## 数据库与验证

数据库契约见 [database.md](database.md)。授权修复与认证租约已获批准并部署生产，三条迁移历史与仓库一致；权限/RLS/RPC 与无身份拒绝已核验，真实客户端/Realtime 联调仍待验收。

`npm run verify` 检查前端构建、单元测试、Rust 与资源流水线；`test:native` 使用独立应用标识验证窗口与退出回执，`test:db` 使用临时本地数据库验证迁移与并发授权。macOS/Windows CI 已配置，Windows 实机与混合 DPI 验收仍待完成。
