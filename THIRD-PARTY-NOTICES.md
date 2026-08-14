# Third-Party Notices

本项目（DSH-Windows桌面版）内置并分发以下第三方开源软件。根据各软件的 MIT 许可证要求，
分发本项目（含其安装包）时，必须随附以下版权声明与许可证文本。

---

## DeepSeek Harness

- 项目地址：https://github.com/deepseek-ai/deepseek-harness
- 许可证：MIT License
- 版权：Copyright (c) 2026 DeepSeek

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Electron

- 项目地址：https://github.com/electron/electron
- 许可证：MIT License
- 版权：Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.

```
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 其他依赖

本项目运行时（`dsh-runtime/`）还包含 DeepSeek Harness 的大量 `@deepseek-ai/*` 依赖包及其传递依赖
（共 516 个包），它们各自携带 MIT 等开源许可证。已扫描确认，**无 GPL 类强传染性许可证**。主要分布：

- MIT：428 个
- Apache-2.0：55 个
- BSD-3-Clause：15 个、BSD-2-Clause：2 个
- ISC：11 个、0BSD：1 个
- 两个需留意的特殊许可证：
  - `argparse`（Python-2.0）——宽松许可证（类似 MIT/BSD），允许商用与再分发；
  - `@img/sharp-win32-x64`（Apache-2.0 AND LGPL-3.0-or-later）——双许可，可按 Apache-2.0 使用，
    且为动态加载（Node require），满足 LGPL 的替换要求。

完整清单与许可证文本见 `dsh-runtime/node_modules/` 内各包的 `LICENSE` 文件。
