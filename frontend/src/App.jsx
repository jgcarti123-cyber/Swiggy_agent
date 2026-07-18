import { useState } from "react";
import { AuthGate } from "./components/AuthGate.jsx";
import { DishCompare } from "./components/DishCompare.jsx";
import { InstamartChat } from "./components/InstamartChat.jsx";
import { Sidebar } from "./components/Sidebar.jsx";

const TABS = [
  { id: "feast", label: "Feast Finder", sub: "Compare dish prices nearby", icon: "feast" },
  { id: "insta-nt", label: "Insta-nt", sub: "Chat to fill your cart", icon: "insta-nt" },
];

function App() {
  const [active, setActive] = useState("feast");

  return (
    <div className="app">
      <Sidebar tabs={TABS} active={active} onSelect={setActive} />
      <div className="main">
        <AuthGate>
          <main className="content">
            <div className="feature-pane" hidden={active !== "feast"}>
              <DishCompare />
            </div>
            <div className="feature-pane" hidden={active !== "insta-nt"}>
              <InstamartChat />
            </div>
          </main>
        </AuthGate>
      </div>
    </div>
  );
}

export default App;
