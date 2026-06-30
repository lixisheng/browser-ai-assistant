import { copyElementImageToClipboard, copyOrDownloadMessageImage, copyTextToClipboard, createMessageImageFilename } from "../../../src/side-panel/utils/messageClipboard";

describe("messageClipboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("复制 Markdown 文本到剪贴板", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText,
      },
    });

    await copyTextToClipboard("# 标题");

    expect(writeText).toHaveBeenCalledWith("# 标题");
  });

  it("文本剪贴板写入失败时返回中文错误", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });

    await expect(copyTextToClipboard("内容")).rejects.toThrow("复制失败，请重试");
  });

  it("图片剪贴板写入成功时不触发下载", async () => {
    stubCanvasImageRendering();
    const write = vi.fn(async (_items: ClipboardItem[]) => undefined);
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write,
      },
    });
    const download = stubDownloadAnchor();

    const result = await copyOrDownloadMessageImage("# 标题", "消息.png");

    expect(result).toBe("copied");
    expect(write).toHaveBeenCalledTimes(1);
    expect(download.createObjectURL).not.toHaveBeenCalled();
    expect(download.click).not.toHaveBeenCalled();
  });

  it("不支持 ClipboardItem 时降级下载 PNG", async () => {
    stubCanvasImageRendering();
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => undefined),
      },
    });
    const download = stubDownloadAnchor();

    const result = await copyOrDownloadMessageImage("# 标题", "消息.png");

    expect(result).toBe("downloaded");
    expect(download.anchor.download).toBe("消息.png");
    expect(download.click).toHaveBeenCalledTimes(1);
    expect(download.revokeObjectURL).toHaveBeenCalledWith("blob:message-image");
  });

  it("生成 AI 消息图片文件名", () => {
    expect(createMessageImageFilename(Date.UTC(2023, 10, 14, 22, 16, 40))).toBe("AI消息-2023-11-14.png");
  });

  it("导出超长 Markdown 图片时在图片底部提示内容已截断", async () => {
    const { fillText } = stubCanvasImageRendering();
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => {
          throw new Error("剪贴板不可用");
        }),
      },
    });
    stubDownloadAnchor();
    const markdown = Array.from({ length: 1800 }, (_, index) => `第 ${index + 1} 行内容`).join("\n");

    await copyOrDownloadMessageImage(markdown, "超长消息.png");

    expect(fillText).toHaveBeenCalledWith("...内容过长已截断", expect.any(Number), expect.any(Number));
  });

  it("复制 DOM 元素渲染后的 PNG 图片到剪贴板", async () => {
    stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoading();
    const write = vi.fn(async (_items: ClipboardItem[]) => undefined);
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write,
      },
    });
    const table = createMeasuredTable(320, 120);
    table.innerHTML = "<table><tbody><tr><td>阶段</td><td>结果</td></tr></tbody></table>";

    await copyElementImageToClipboard(table);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("复制 DOM 元素图片时按高清倍率生成 PNG", async () => {
    const { fillRect } = stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoading();
    const canvas = document.createElement("canvas");
    vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      if (tagName.toLowerCase() === "canvas") {
        return canvas;
      }

      return Document.prototype.createElement.call(document, tagName, options);
    });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async (_items: ClipboardItem[]) => undefined),
      },
    });

    await copyElementImageToClipboard(createMeasuredTable(320, 120, 320, 160));

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(320);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 320, 160);
  });

  it("复制 DOM 元素图片时不把表头操作按钮写入图片内容", async () => {
    const { fillText } = stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoading();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async (_items: ClipboardItem[]) => undefined),
      },
    });
    const table = createMeasuredTable(320, 120);
    table.innerHTML = [
      "<thead><tr><th>阶段</th><th>",
      '<span data-markdown-table-actions="true">',
      "<button>复制表格 Markdown</button>",
      "<button>复制表格图片</button>",
      "</span>",
      "</th></tr></thead>",
      "<tbody><tr><td>第一行</td><td>通过</td></tr></tbody>",
    ].join("");
    setMeasuredTableCells(table, [
      [
        { width: 100, height: 40, left: 0, top: 0 },
        { width: 220, height: 40, left: 100, top: 0 },
      ],
      [
        { width: 100, height: 80, left: 0, top: 40 },
        { width: 220, height: 80, left: 100, top: 40 },
      ],
    ]);

    await copyElementImageToClipboard(table);

    expect(fillText).toHaveBeenCalledWith("第一行", expect.any(Number), expect.any(Number));
    expect(fillText).not.toHaveBeenCalledWith(expect.stringContaining("复制表格 Markdown"), expect.any(Number), expect.any(Number));
  });

  it("复制 DOM 元素图片时按单元格真实高度绘制换行文本", async () => {
    const { fillText } = stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoading();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async (_items: ClipboardItem[]) => undefined),
      },
    });
    const table = createMeasuredTable(25, 80);
    table.innerHTML = "<tbody><tr><td>abcdefgh</td></tr></tbody>";
    setMeasuredTableCells(table, [[{ width: 25, height: 80, left: 0, top: 0 }]]);

    await copyElementImageToClipboard(table);

    expect(fillText).toHaveBeenCalledWith("ab", 1, 1);
    expect(fillText).toHaveBeenCalledWith("cd", 1, 17);
    expect(fillText).toHaveBeenCalledWith("ef", 1, 33);
    expect(fillText).toHaveBeenCalledWith("gh", 1, 49);
  });

  it("复制富内容表格图片时仍走表格绘制路径避免 SVG 裁切", async () => {
    const { drawImage, fillText } = stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoading();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async (_items: ClipboardItem[]) => undefined),
      },
    });
    const table = createMeasuredTable(320, 120);
    table.innerHTML = "<tbody><tr><td><strong>重点</strong><code>code</code></td></tr></tbody>";
    setMeasuredTableCells(table, [[{ width: 320, height: 120, left: 0, top: 0 }]]);

    await copyElementImageToClipboard(table);

    expect(drawImage).not.toHaveBeenCalled();
    expect(fillText).toHaveBeenCalledWith("重点code", expect.any(Number), expect.any(Number));
  });

  it("复制 DOM 图片时剪贴板图片能力缺失会返回中文错误", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => undefined),
      },
    });

    await expect(copyElementImageToClipboard(createMeasuredElement(320, 120))).rejects.toThrow("当前环境不支持复制图片到剪贴板");
  });

  it("复制 DOM 图片时 canvas 无法生成 PNG 会返回中文错误", async () => {
    stubCloneLayoutMeasurements();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => undefined),
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback) {
      callback(null);
    });
    stubImageLoading();

    await expect(copyElementImageToClipboard(createMeasuredElement(320, 120))).rejects.toThrow("无法生成表格图片");
    expect(document.querySelector("[data-element-image-measure-root]")).toBeNull();
  });

  it("复制 DOM 图片时图片加载失败会返回中文错误并清理离屏容器", async () => {
    stubCanvasImageRendering();
    stubCloneLayoutMeasurements();
    stubImageLoadingFailure();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => undefined),
      },
    });

    await expect(copyElementImageToClipboard(createMeasuredElement(320, 120))).rejects.toThrow("无法生成表格图片");
    expect(document.querySelector("[data-element-image-measure-root]")).toBeNull();
  });

  it("复制 DOM 图片时元素尺寸过大会返回中文错误", async () => {
    stubCloneLayoutMeasurements();
    vi.stubGlobal("ClipboardItem", class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        write: vi.fn(async () => undefined),
      },
    });

    await expect(copyElementImageToClipboard(createMeasuredElement(9000, 120))).rejects.toThrow("表格尺寸过大，无法复制为图片");
  });
});

function stubCanvasImageRendering() {
  const fillText = vi.fn();
  const fillRect = vi.fn();
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    fillRect,
    fillText,
    drawImage,
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    strokeRect: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback) {
    callback(new Blob(["png"], { type: "image/png" }));
  });

  return { drawImage, fillRect, fillText };
}

function createMeasuredElement(width: number, height: number, exportWidth = width, exportHeight = height): HTMLElement {
  const element = document.createElement("div");
  setMeasuredRect(element, exportWidth, exportHeight);
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: width });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: height });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  return element;
}

function createMeasuredTable(width: number, height: number, exportWidth = width, exportHeight = height): HTMLTableElement {
  const table = document.createElement("table");
  setMeasuredRect(table, exportWidth, exportHeight);
  Object.defineProperty(table, "scrollWidth", { configurable: true, value: width });
  Object.defineProperty(table, "scrollHeight", { configurable: true, value: height });
  return table;
}

function setMeasuredTableCells(table: HTMLTableElement, rows: Array<Array<{ width: number; height: number; left: number; top: number }>>): void {
  for (const [rowIndex, row] of rows.entries()) {
    const tableRow = table.rows[rowIndex];
    if (!tableRow) {
      continue;
    }
    for (const [cellIndex, rect] of row.entries()) {
      const cell = tableRow.cells[cellIndex];
      if (cell) {
        setMeasuredRect(cell, rect.width, rect.height, rect.left, rect.top);
      }
    }
  }
}

function setMeasuredRect(element: HTMLElement, width: number, height: number, left = 0, top = 0): void {
  element.dataset.exportWidth = String(width);
  element.dataset.exportHeight = String(height);
  element.dataset.exportLeft = String(left);
  element.dataset.exportTop = String(top);
}

function stubImageLoading() {
  const imageSources: string[] = [];
  class ImageMock {
    onload: (() => void) | null = null;

    set src(value: string) {
      imageSources.push(value);
      queueMicrotask(() => this.onload?.());
    }
  }

  vi.stubGlobal("Image", ImageMock);
  return { imageSources };
}

function stubImageLoadingFailure() {
  class ImageMock {
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onerror?.());
    }
  }

  vi.stubGlobal("Image", ImageMock);
}

function stubCloneLayoutMeasurements() {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function getScrollWidth(this: HTMLElement) {
    return Number(this.dataset.exportWidth) || 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function getScrollHeight(this: HTMLElement) {
    return Number(this.dataset.exportHeight) || 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
    const width = Number(this.dataset.exportWidth) || 0;
    const height = Number(this.dataset.exportHeight) || 0;
    const left = Number(this.dataset.exportLeft) || 0;
    const top = Number(this.dataset.exportTop) || 0;
    return {
      width,
      height,
      top,
      left,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    };
  });
}

function stubDownloadAnchor() {
  const click = vi.fn();
  const anchor = document.createElement("a");
  Object.defineProperty(anchor, "click", { configurable: true, value: click });
  vi.spyOn(document.body, "appendChild");
  vi.spyOn(document.body, "removeChild");
  vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() === "a") {
      return anchor;
    }

    return Document.prototype.createElement.call(document, tagName, options);
  });
  const createObjectURL = vi.fn(() => "blob:message-image");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL,
    revokeObjectURL,
  });

  return {
    anchor,
    click,
    createObjectURL,
    revokeObjectURL,
  };
}
