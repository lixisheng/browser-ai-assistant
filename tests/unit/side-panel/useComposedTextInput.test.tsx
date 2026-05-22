import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useComposedTextInput } from "../../../src/side-panel/components/useComposedTextInput";

function ComposedTextInputHarness({ initialValue, onCommit }: { initialValue: string; onCommit: (value: string) => void }) {
  const [value, setValue] = useState(initialValue);
  const inputProps = useComposedTextInput(value, (nextValue) => {
    setValue(nextValue);
    onCommit(nextValue);
  });

  return (
    <div>
      <textarea aria-label="组合输入" {...inputProps} />
      <button type="button" onClick={() => setValue("外部值")}>
        外部同步
      </button>
    </div>
  );
}

describe("useComposedTextInput", () => {
  it("组合输入期间保留本地草稿并只提交最终文本", () => {
    const onCommit = vi.fn();

    render(<ComposedTextInputHarness initialValue="你是网页助手，" onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: "组合输入" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "你是网页助手，shizhong" } });

    expect(input).toHaveDisplayValue("你是网页助手，shizhong");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: "你是网页助手，始终" } });

    expect(input).toHaveDisplayValue("你是网页助手，始终");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("你是网页助手，始终");
  });

  it("组合输入期间忽略外部值同步，结束后继续同步外部值", () => {
    const onCommit = vi.fn();

    render(<ComposedTextInputHarness initialValue="初始值" onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: "组合输入" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "caogao" } });
    fireEvent.click(screen.getByRole("button", { name: "外部同步" }));

    expect(input).toHaveDisplayValue("caogao");

    fireEvent.compositionEnd(input, { target: { value: "草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "外部同步" }));

    expect(input).toHaveDisplayValue("外部值");
  });

  it("没有组合开始时触发组合结束也会提交当前文本", () => {
    const onCommit = vi.fn();

    render(<ComposedTextInputHarness initialValue="" onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: "组合输入" });
    fireEvent.compositionEnd(input, { target: { value: "直接结束" } });

    expect(input).toHaveDisplayValue("直接结束");
    expect(onCommit).toHaveBeenCalledWith("直接结束");
  });
});
