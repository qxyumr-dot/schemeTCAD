# schemeTCAD

在 VS Code 中选择 Sentaurus Structure Editor（SDE）Scheme 指令，填写参数并插入到原光标位置。

## 当前版本

- **当前源码版本：0.7.4**，以本目录 `package.json` 中的 `version` 为准。
- **VS Code：1.137.0 或更高的 1.x 版本**，对应 `engines.vscode: ^1.137.0`。
- **本地构建环境：Node.js 24.x 和随附的 npm**。
- 0.7.4 修复辅助页双击 Shift 触发两次切换的问题。完整记录见 [CHANGELOG.md](https://github.com/qxyumr-dot/schemeTCAD/blob/main/schemetcad/CHANGELOG.md)。

## 安装到日常使用的 VS Code

安装需要 `.vsix` 文件。GitHub 仓库保存源码，VSIX 不纳入 Git；下载源码后，请在**包含 `package.json` 的插件目录**生成当前版本的安装包。旧版安装包不会因为源码更新而自动升级。

### 从源码生成 VSIX

获取源码后进入内层 `schemetcad` 文件夹，执行：

```powershell
npm.cmd ci
npm.cmd run compile
npm.cmd run lint
```

首次使用时安装打包工具：

```powershell
npm.cmd install --global @vscode/vsce
```

生成当前版本安装包：

```powershell
vsce.cmd package --no-dependencies --allow-missing-repository --skip-license --out schemetcad-0.7.4.vsix
```

安装包生成在当前目录。`--no-dependencies` 对应本项目没有运行时 npm 依赖；另外两个选项允许目前尚未配置 repository 字段和许可证文件的项目本地打包。Windows PowerShell 中使用 `.cmd` 命令，可避免 `npm.ps1` 等脚本被执行策略拦截。

### 安装并确认版本

1. 在 VS Code 按 **Ctrl+Shift+X** 打开扩展面板。
2. 点击面板右上角 **…**，选择 **Install from VSIX… / 从 VSIX 安装…**。也可在命令面板运行 **Extensions: Install from VSIX…**。
3. 选择 `schemetcad-0.7.4.vsix`，按提示重新加载窗口。
4. 在扩展面板查看 **schemeTCAD**，确认版本为 **0.7.4** 且已启用。

如果 VS Code 命令行工具已加入 PATH，也可以在安装包目录执行：

```powershell
code.cmd --install-extension .\schemetcad-0.7.4.vsix
```

以后更新源码版本时，重新编译、打包并安装对应版本的 VSIX。有关安装操作，参考 [VS Code 官方说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)。

## 使用

1. 打开待编辑的 SDE Scheme 文件，把光标放在目标位置。
2. 连续按两次 **Shift**，即可打开辅助界面，或在代码编辑器和辅助界面之间切换。**Ctrl+Shift+Q** 保留为备用快捷键；**Alt+Q** 也可以打开辅助界面。当前文件首次打开辅助界面时，会同时打开“SDE 文件概览”面板。默认布局为代码第一列、语句辅助第二列、文件概览第三列。
3. 光标位于已有模块内时，直接显示该模块的函数列表；位于模块外时，先选择分类。选择分类后，插件会在当前空行或当前代码行之后建立注释模块，并把代码光标放到模块内的空行开头。
4. 在参数页面填写参数。输入框下方显示用途和示例；材料、掺杂物种可选常用值。底部预览以 `[当前值...]` 标记正在填写的参数；Enter 跳到下一项，在最后一项按 Enter 插入。
5. 每条插入的语句末尾都会补一个换行，光标停在下一行开头。辅助界面保留；代码光标移动后，辅助界面立即按新位置显示分类或对应函数，同时焦点继续留在代码编辑器。连续按两次 **Shift** 或用鼠标点击辅助界面可切换焦点；在辅助页再次双击 **Shift** 返回代码编辑器。

插件创建的模块使用普通 Scheme 注释：

```scheme
;===== schemeTCAD:begin init
; 初始化操作类

;===== schemeTCAD:end init
```

模块内的空行用于插入语句。若光标仍在模块内，即使在辅助界面点击“返回”再选择分类，插件也会保持在当前模块的函数列表，避免在模块内新建模块。要新建模块，请先把代码光标移到模块外。

当前函数库含初始化、图形、Contact、Mesh、掺杂五类，共 41 条语句，存放在 `function-library/sde_functions.txt`。插件每次打开界面时重新读取该文件，无须修改代码即可新增函数或参数。该 TXT 文件采用 UTF-8 JSON 格式；可以在 `function-library` 中加入更多符合相同格式的 `.txt` 文件。函数 `id` 必须唯一，每个模板占位符 `{{参数id}}` 都需要在 `parameters` 中定义。模板里的 Scheme 字符串双引号应写在占位符外，例如 `"{{region}}"`。

二维坐标指令只填写 X/Y，生成的 `(position X Y 0)` 将 Z 固定为 0；三维指令分别填写 X/Y/Z。每条语句还记录了 `source` 教程链接，便于核对对应的 SDE 示例。

`scheme_expr` 参数直接进入 Scheme 代码，`scheme_string` 参数会对反斜杠和双引号转义，`enum` 参数仅接受 `choices` 中的值。`enum` 还可用 `code_values` 把界面选项映射为实际 Scheme 片段，例如单侧细化映射为空字符串，双侧细化映射为 ` "DoubleSide"`。不能填写的参数会显示错误，不会插入代码。

## 文件概览与参数候选

首次为某个文件打开辅助界面时，插件会在右侧增加“SDE 文件概览”面板。上方按函数库的五个分类展示模块进度：模块内有 Scheme 语句，或旧文件中检测到对应类别的指令时打勾；仅有空模块注释时显示“尚无代码”。下方分别列出当前文件中的 `define` 变量与 SDE 参数、区域名称及材料/形状/坐标、掺杂分布及浓度、Contact、Ref/Eval 窗口和网格细化定义。面板随当前文件的未保存修改刷新。关闭后如需重开，在命令面板运行 **Scheme TCAD: 显示文件概览**。

主辅助界面的输入框不再显示已建立区域、Contact、窗口、网格细化和掺杂分布的候选小框；这些名称集中显示在文件概览中。材料和掺杂物种仍显示可选项。材料列表来自函数库的 `suggestion_lists.materials` 和当前文件已使用的材料；不同 Sentaurus 安装的材料库可能不同，仍可手动输入其他材料。

插件实际读取 `function-library/sde_functions.txt`（以及该目录其他 `.txt`）；项目根目录下的同名文件不会被读取。

## 快捷键说明

双击 **Shift** 已直接写入扩展的快捷键配置；VS Code 的图形化快捷键录入界面可能无法正确录入这个组合。**Ctrl+Shift+Q** 仍可用于双向切换。如果系统输入法占用双击 Shift，可在 VS Code 的 `keybindings.json` 中覆盖这一组合。

## 开发与安装

开发时，在 VS Code 中打开本目录 `schemetcad`，先运行 `npm.cmd ci`，再按 **F5** 启动扩展开发宿主。当前调试配置会自动启动 TypeScript 监视编译。开发宿主是独立的调试窗口；要在日常 VS Code 中使用，请按本文的 VSIX 步骤安装。

独立编译与检查命令：

```powershell
npm.cmd run compile
npm.cmd run lint
```

Git 仓库根目录在本目录的上一层：Git 提交在外层执行，npm 和 vsce 在本目录执行。`node_modules`、`out`、`dist` 和 `.vsix` 已被忽略，但 `package-lock.json` 应保留在 Git 中。

## 常见问题

- **PowerShell 禁止运行 npm.ps1：**改用 `npm.cmd`，无需为了构建插件修改执行策略。
- **找不到 package.json：**进入内层 `schemetcad` 文件夹再运行构建命令。
- **VS Code 版本不兼容：**检查当前 VS Code 是否满足 `^1.137.0`。
- **插件仍为旧版本：**重新打包并安装当前版本，重新加载窗口后检查扩展详情页。
- **双击 Shift 被输入法占用：**使用 Alt+Q 打开界面，或使用 Ctrl+Shift+Q 切换焦点。

此项目生成 SDE Scheme 代码；不会直接执行 Sentaurus，也不会检查模型中是否真的存在所引用的区域、接触或网格窗口。
