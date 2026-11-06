/** Reusable empty state (no results, no data yet, error fallbacks). */
export function EmptyState({ icon = '◎', title, description, action = null }) {
  return (
    <div className="empty-state card">
      <div className="empty-state__icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export default EmptyState;
