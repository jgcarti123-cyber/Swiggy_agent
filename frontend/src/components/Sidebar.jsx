function FeastIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
      <path d="M7 2v20" />
      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </svg>
  );
}

function InstaNtIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

const ICONS = { feast: FeastIcon, "insta-nt": InstaNtIcon };

export function Sidebar({ tabs, active, onSelect }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="13" fill="currentColor" />
            <path d="M14 20h20a1 1 0 0 1 1 1 11 11 0 0 1-11 11 11 11 0 0 1-11-11 1 1 0 0 1 1-1Z" fill="#fff" />
            <path d="M24 13v3M20 14.5v2M28 14.5v2" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
        <div className="brand-text">
          <span className="brand-name">Swiggy</span>
          <span className="brand-tag">Personal Dashboard</span>
        </div>
      </div>

      <nav className="nav">
        <p className="nav-heading">Choose a service</p>
        {tabs.map((tab) => {
          const Icon = ICONS[tab.icon] || FeastIcon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={`nav-bar${isActive ? " nav-bar--active" : ""}`}
              onClick={() => onSelect(tab.id)}
              aria-pressed={isActive}
            >
              <span className="nav-bar-icon">
                <Icon />
              </span>
              <span className="nav-bar-text">
                <span className="nav-bar-label">{tab.label}</span>
                <span className="nav-bar-sub">{tab.sub}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <p className="sidebar-foot">Local dashboard · single user</p>
    </aside>
  );
}
