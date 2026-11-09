import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  const [api, setApi] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [apiResponse, usersResponse] = await Promise.all([
          fetch("/api"),
          fetch("/api/users")
        ]);
        if (!apiResponse.ok || !usersResponse.ok) {
          throw new Error("API request failed");
        }
        setApi(await apiResponse.json());
        setUsers(await usersResponse.json());
      } catch (e) {
        setError(e.message);
      }
    }
    load();
  }, []);

  return (
    <main className="container">
      <h1>AWS EKS Three-Tier Application</h1>
      <p className="subtitle">React frontend · Node.js backend · MySQL database</p>
      {error && <p className="error">Backend error: {error}</p>}
      {api && <section className="panel">
        <h2>Backend response</h2>
        <p>{api.message}</p>
        <small>Database service: {api.database}</small>
      </section>}
      <section className="panel">
        <h2>Users from MySQL</h2>
        {users.length === 0 ? <p>No users returned yet.</p> : (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Email</th></tr></thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id}>
                  <td>{user.id}</td><td>{user.name}</td><td>{user.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
