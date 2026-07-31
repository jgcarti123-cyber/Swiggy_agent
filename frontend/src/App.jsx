import { useState } from "react";
import { AuthGate } from "./components/AuthGate.jsx";
import { DishCompare } from "./components/DishCompare.jsx";
import { InstamartChat } from "./components/InstamartChat.jsx";
import { Sidebar } from "./components/Sidebar.jsx";

const TABS = [
  { id: "feaster", label: "Feaster", sub: "Compare dish prices nearby", icon: "feaster" },
  { id: "insta-nt", label: "Insta-nt", sub: "Chat to fill your cart", icon: "insta-nt" },
];

function App() {
  const [active, setActive] = useState("feaster");

  return (
    <div className="app">
      <Sidebar tabs={TABS} active={active} onSelect={setActive} />
      <div className="main">
        <AuthGate>
          <main className="content">
            <div className="feature-pane" hidden={active !== "feaster"}>
              <DishCompare />
            </div>
            <div className="feature-pane" hidden={active !== "insta-nt"}>
              <InstamartChat isActive={active === "insta-nt"} />
            </div>
          </main>
        </AuthGate>
      </div>
    </div>
  );
}

export default App;
