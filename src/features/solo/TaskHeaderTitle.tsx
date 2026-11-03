import type {
  TaskHeaderTitleProps,
  TaskHeaderUI,
} from "../channel-navigation/solo-navigation-contract";
import styles from "../messages/Messages.module.css";
import { FolderSimpleIcon, XIcon } from "../../shared/design-system/icons";

function TaskHeaderTitle({ title, actions }: TaskHeaderTitleProps) {
  const remove = actions?.find((action) => action.id === "remove-project");
  const label = (
    <>
      <span className={styles.taskProjectIcon} aria-hidden="true">
        <FolderSimpleIcon />
        {remove && <XIcon />}
      </span>
      <span className="inline-chip-label text-label-sm">{title}</span>
    </>
  );
  return (
    <div className={styles.taskProjectTag}>
      {remove ? (
        <button
          type="button"
          className="inline-chip"
          aria-label={remove.label}
          disabled={remove.disabled}
          onClick={() => void remove.onSelect()}
        >
          {label}
        </button>
      ) : (
        <span role="status" className="inline-chip">
          {label}
        </span>
      )}
    </div>
  );
}
export const taskHeaderUI: TaskHeaderUI = Object.freeze({
  Title: TaskHeaderTitle,
});
