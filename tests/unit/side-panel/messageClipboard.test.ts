import { copyOrDownloadMessageImage, copyTextToClipboard, createMessageImageFilename } from "../../../src/side-panel/utils/messageClipboard";

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
});

function stubCanvasImageRendering() {
  const fillText = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    font: "",
    textBaseline: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    fillRect: vi.fn(),
    fillText,
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback) {
    callback(new Blob(["png"], { type: "image/png" }));
  });

  return { fillText };
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
