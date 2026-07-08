import { AuthGate } from "./components/AuthGate.jsx";
import { DishCompare } from "./components/DishCompare.jsx";
import { InstamartChat } from "./components/InstamartChat.jsx";

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Swiggy Personal Dashboard</h1>
      </header>
      <AuthGate>
        <main className="panels">
          <DishCompare />
          <InstamartChat />
        </main>
      </AuthGate>
    </div>
  );
}

export default App;
