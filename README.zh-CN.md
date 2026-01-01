# pup

AI Agent 浏览器自动化工具。

![demo](demo.gif)

```bash
pup goto https://google.com
pup scan
pup click 3
pup type 2 "hello world" --enter
```

## 这是什么

LLM 看不到浏览器里的内容。pup 通过 DevTools Protocol 连接 Chrome，把页面元素扫描成结构化数据，让 Agent 能理解和操作页面。

- **AXTree 扫描** - 通过无障碍树获取页面元素，语义化识别按钮/链接/输入框，无需 CSS 选择器
- **Agent 优先** - 所有命令支持 JSON 输出，支持管道和 stdin
- **隐身模式** - 集成 puppeteer-extra-stealth，绕过大部分反爬检测
- **DevTools 能力** - 完整 CDP 能力：网络抓包、脚本调试、Cookie/Storage 管理
- **性能分析** - Core Web Vitals、CPU 分析、内存分析、网络瀑布图
- **插件架构** - 模块化，按需加载

## 安装

```bash
npm install -g @sdjz/pup
```

## 快速开始

```bash
# 打开页面
pup goto https://example.com

# 扫描页面元素
pup scan --no-empty

# 通过元素 ID 交互
pup click 5
pup type 3 "search" --enter

# JSON 输出
pup scan --json
```

## 命令

### 导航

```bash
goto <url>              # 打开 URL
back / forward          # 历史导航
reload                  # 刷新页面
scroll <up|down|top|bottom>  # 滚动
wait <ms>               # 等待毫秒
```

### 元素交互

```bash
scan                    # 扫描元素，获取 ID
scanall                 # 扫描整个页面（滚动）
find <text>             # 按文本查找元素
click <id>              # 点击元素
click <id> --js         # JS 点击（用于模态框）
type <id> <text>        # 输入文本
type <id> <text> --enter --clear  # 清空、输入、回车
hover <id>              # 鼠标悬停
select <id> <option>    # 选择下拉选项
```

### 标签页管理

```bash
tabs                    # 列出所有标签页
tab <id>                # 切换标签页
newtab [url]            # 新建标签页
close                   # 关闭当前标签页
closetab <id>           # 关闭指定标签页
```

### DevTools

```bash
network                 # 查看请求
network --capture       # 启用 XHR 抓包
network --xhr           # 查看抓到的 XHR
cookies                 # 查看 cookies
cookies --set name=val  # 设置 cookie
storage                 # 查看 localStorage
storage --session       # 查看 sessionStorage
scripts                 # 列出页面脚本
scripts --search <q>    # 搜索脚本内容
var <path>              # 读取全局变量
exec <js>               # 执行 JavaScript
hook <func> <code>      # Hook 函数
cdp <method> [params]   # 原始 CDP 命令
dom <selector>          # 查询 DOM
```

### 性能分析

```bash
perf                    # 快速概览（Web Vitals）
perf --reload           # 刷新后测量
perf-load [url]         # 完整页面加载分析
perf-js                 # JavaScript CPU 分析
perf-memory             # 内存和 DOM 分析
perf-network            # 网络瀑布图
perf-longtasks          # 主线程阻塞
perf-trace              # 完整时间线追踪
perf-analyze            # AI 级详细分析
```

### 文件传输

```bash
upload <file>           # 上传文件
download <url>          # 下载文件
download links          # 列出可下载链接
screenshot [file]       # 截图
```

### 其他

```bash
emulate <device>        # iphone/ipad/android
emulate viewport 1920x1080
ipinfo                  # IP 和位置信息
status                  # 当前页面信息
ping                    # 连接测试
```

完整帮助: `pup help`  
命令详情: `pup help <command>`

## Agent 集成

pup 输出专为 LLM 设计 - 结构化文本，易于阅读：

```bash
$ pup scan --no-empty --limit 5
[+] SCAN 150ms
    title Google
    url https://www.google.com/
    ◆ 5 elements in 874x560

    [  1] link     "Gmail"
    [  2] combobox "Search"
    [  3] button   "Google Search"
    [  4] button   "I'm Feeling Lucky"
    [  5] link     "About"
```

LLM 直接读取输出，理解页面，决定下一步操作。

### 典型工作流

```
1. pup goto https://example.com    # 打开页面
2. pup scan --no-empty             # 扫描元素
3. LLM 决定: 点击元素 5
4. pup click 5                     # 执行
5. pup scan --no-empty             # 检查结果
6. ...循环
```

### 批量模式

```bash
pup batch "goto https://example.com ; scan --no-empty ; click 3"
```

### JSON 模式

```bash
pup scan --json
# {"ok":true,"cmd":"SCAN","elements":[...]}
```

### REPL 模式

```bash
pup --json
{"cmd":"GOTO","url":"https://example.com"}
{"cmd":"SCAN"}
```
