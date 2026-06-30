import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownTableText, MarkdownTableBlock } from "../../../src/side-panel/components/MarkdownTableBlock";

const copyTextToClipboardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const copyElementImageToClipboardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../../src/side-panel/utils/messageClipboard", () => ({
  copyTextToClipboard: copyTextToClipboardMock,
  copyElementImageToClipboard: copyElementImageToClipboardMock,
}));

function renderTable() {
  return render(
    <MarkdownTableBlock>
      <thead>
        <tr>
          <th>名称</th>
          <th>说明</th>
          <th>空列</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>A|B</td>
          <td>{"第一行\n第二行 | 备注"}</td>
          <td />
        </tr>
      </tbody>
    </MarkdownTableBlock>,
  );
}

describe("MarkdownTableBlock", () => {
  it("渲染真实表格并提供表头操作区", () => {
    renderTable();

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.querySelector(".markdown-table-block-toolbar")).toBeNull();
    expect(document.querySelector(".markdown-table-block-actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制表格 Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制表格图片" })).toBeInTheDocument();
  });

  it("复制按钮真实插入最后一个表头单元格并居右显示", () => {
    renderTable();

    const headers = screen.getAllByRole("columnheader");
    const lastHeader = headers.at(-1);
    expect(lastHeader).toContainElement(screen.getByRole("button", { name: "复制表格 Markdown" }));
    expect(lastHeader).toContainElement(screen.getByRole("button", { name: "复制表格图片" }));
    expect(lastHeader?.querySelector(".markdown-table-block-header-content")).toBeInTheDocument();
    expect(lastHeader?.querySelector(".markdown-table-block-actions")).toBeInTheDocument();
  });

  it("表格操作区复用消息操作按钮样式", () => {
    renderTable();

    expect(screen.getByRole("button", { name: "复制表格 Markdown" })).toHaveClass("message-icon-button");
    expect(screen.getByRole("button", { name: "复制表格图片" })).toHaveClass("message-icon-button");
  });

  it("复制 Markdown 时基于渲染后的表格重建 GFM 表格文本", async () => {
    const user = userEvent.setup();
    copyTextToClipboardMock.mockClear();
    renderTable();

    await user.click(screen.getByRole("button", { name: "复制表格 Markdown" }));

    expect(copyTextToClipboardMock).toHaveBeenCalledWith([
      "| 名称 | 说明 | 空列 |",
      "| --- | --- | --- |",
      "| A\\|B | 第一行 第二行 \\| 备注 |  |",
    ].join("\n"));
    expect(await screen.findByText("已复制")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制表格 Markdown" }));
    expect(copyTextToClipboardMock).toHaveBeenLastCalledWith([
      "| 名称 | 说明 | 空列 |",
      "| --- | --- | --- |",
      "| A\\|B | 第一行 第二行 \\| 备注 |  |",
    ].join("\n"));
  });

  it("复制图片时传入当前渲染表格元素", async () => {
    const user = userEvent.setup();
    copyElementImageToClipboardMock.mockClear();
    renderTable();

    await user.click(screen.getByRole("button", { name: "复制表格图片" }));

    const table = screen.getByRole("table");
    expect(copyElementImageToClipboardMock).toHaveBeenCalledWith(table);
    expect(await screen.findByText("图片已复制")).toBeInTheDocument();
  });

  it("复制失败时只显示失败反馈", async () => {
    const user = userEvent.setup();
    copyElementImageToClipboardMock.mockRejectedValueOnce(new Error("copy failed"));
    renderTable();

    await user.click(screen.getByRole("button", { name: "复制表格图片" }));

    await waitFor(() => expect(screen.queryByText("图片已复制")).not.toBeInTheDocument());
    expect(await screen.findByText("复制失败")).toBeInTheDocument();
  });

  it("空表格复制 Markdown 时返回空字符串", () => {
    const table = document.createElement("table");

    expect(createMarkdownTableText(table)).toBe("");
  });

  it("没有表头时不插入复制按钮", () => {
    render(
      <MarkdownTableBlock>
        <tbody>
          <tr>
            <td>内容</td>
          </tr>
        </tbody>
      </MarkdownTableBlock>,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制表格 Markdown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制表格图片" })).not.toBeInTheDocument();
  });
});
