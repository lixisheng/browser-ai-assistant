import { describe, expect, it } from "vitest";
import { isPngDataUrl, isTabCaptureImageAttachment, TAB_CAPTURE_SCREENSHOT_NAME } from "../../../src/shared/tabCapture";

describe("标签页截图共享工具", () => {
  it("只接受合法 PNG data URL，且 base64 填充只能出现在末尾", () => {
    expect(isPngDataUrl("data:image/png;base64,QUJD")).toBe(true);
    expect(isPngDataUrl("data:image/png;base64,QUI=")).toBe(true);
    expect(isPngDataUrl("data:image/png;base64,QQ==")).toBe(true);

    expect(isPngDataUrl("data:image/png;base64,Q=JD")).toBe(false);
    expect(isPngDataUrl("data:image/jpeg;base64,QUJD")).toBe(false);
    expect(isPngDataUrl("not-a-data-url")).toBe(false);
  });

  it("校验截图附件元信息时要求 id 是非空字符串", () => {
    const attachment = {
      id: "screenshot-1",
      name: TAB_CAPTURE_SCREENSHOT_NAME,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,QUJD",
    };

    expect(isTabCaptureImageAttachment(attachment)).toBe(true);
    expect(isTabCaptureImageAttachment({ ...attachment, id: "" })).toBe(false);
    expect(isTabCaptureImageAttachment({ ...attachment, id: 1 })).toBe(false);
  });
});
