import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  TaskHeaderTitleProps,
  TaskHeaderUI,
} from "../channel-navigation/solo-navigation-contract";

function TaskHeaderTitle({ title, actions }: TaskHeaderTitleProps) {
  return (
    <InlineHeader
      title={<span role="status">{title}</span>}
      actions={actions?.map((action) => (
        <Button
          key={action.id}
          size="sm"
          variant="ghost"
          disabled={action.disabled}
          onClick={() => {
            void action.onSelect();
          }}
        >
          {action.label}
        </Button>
      ))}
    />
  );
}
export const taskHeaderUI: TaskHeaderUI = Object.freeze({
  Title: TaskHeaderTitle,
});
