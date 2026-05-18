const STORAGE_KEY = "studyshare_state_v1";

let state = loadState();
let currentUserId = sessionStorage.getItem("studyshare_current_user");
let resources = [];

const authSection = document.querySelector("#authSection");
const uploadPanel = document.querySelector("#upload");
const adminPanel = document.querySelector("#adminPanel");
const adminNav = document.querySelector("#adminNav");
const logoutBtn = document.querySelector("#logoutBtn");
const profileText = document.querySelector("#profileText");
const resourceList = document.querySelector("#resourceList");
const adminList = document.querySelector("#adminList");
const subjectFilter = document.querySelector("#subjectFilter");
const toast = document.querySelector("#toast");

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved);

  const initialState = {
    users: [
      {
        id: "admin-demo-user",
        name: "Admin",
        email: "admin@studyshare.local",
        password: "admin123",
        role: "admin",
        createdAt: new Date().toISOString()
      }
    ],
    resources: []
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initialState));
  return initialState;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getCurrentUser() {
  return state.users.find((user) => user.id === currentUserId) || null;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2800);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function updateSessionUI() {
  const currentUser = getCurrentUser();
  const isLoggedIn = Boolean(currentUser);
  authSection.classList.toggle("hidden", isLoggedIn);
  uploadPanel.classList.toggle("hidden", !isLoggedIn);
  logoutBtn.classList.toggle("hidden", !isLoggedIn);
  profileText.textContent = isLoggedIn
    ? `${currentUser.name} (${currentUser.role}) is logged in.`
    : "Log in or create an account to upload materials.";

  const isAdmin = currentUser && currentUser.role === "admin";
  adminPanel.classList.toggle("hidden", !isAdmin);
  adminNav.classList.toggle("hidden", !isAdmin);
}

function applyFilters(params = {}) {
  const query = String(params.q || "").trim().toLowerCase();
  const subject = String(params.subject || "").trim().toLowerCase();
  resources = state.resources
    .filter((resource) => {
      const matchesSubject = !subject || resource.subject.toLowerCase() === subject;
      const haystack = `${resource.title} ${resource.subject} ${resource.description} ${resource.uploaderName}`.toLowerCase();
      return matchesSubject && (!query || haystack.includes(query));
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderResources() {
  if (!resources.length) {
    resourceList.innerHTML = '<div class="empty">No resources found. Be the first to share one.</div>';
    adminList.innerHTML = '<div class="empty">No uploads to manage.</div>';
    return;
  }

  resourceList.innerHTML = resources
    .map(
      (resource) => `
        <article class="resource-card">
          <div>
            <h3>${escapeHtml(resource.title)}</h3>
            <p>${escapeHtml(resource.description)}</p>
          </div>
          <div class="meta">
            <span>Subject: ${escapeHtml(resource.subject)}</span>
            <span>Shared by ${escapeHtml(resource.uploaderName)}</span>
            <span>${formatDate(resource.createdAt)}</span>
          </div>
          <div class="actions">
            ${
              resource.fileData
                ? `<a href="${resource.fileData}" download="${escapeAttribute(resource.fileName)}">Download ${escapeHtml(resource.fileName)}</a>`
                : ""
            }
            ${resource.link ? `<a class="secondary" href="${escapeAttribute(resource.link)}" target="_blank" rel="noreferrer">Open Link</a>` : ""}
          </div>
        </article>
      `
    )
    .join("");

  adminList.innerHTML = resources
    .map(
      (resource) => `
        <article class="resource-card">
          <h3>${escapeHtml(resource.title)}</h3>
          <div class="meta">
            <span>${escapeHtml(resource.subject)}</span>
            <span>Uploaded by ${escapeHtml(resource.uploaderName)}</span>
          </div>
          <button class="danger" data-delete="${resource.id}">Remove Resource</button>
        </article>
      `
    )
    .join("");
}

function renderSubjects() {
  const selected = subjectFilter.value;
  const subjects = [...new Set(state.resources.map((resource) => resource.subject))].sort();
  subjectFilter.innerHTML = '<option value="">All subjects</option>';
  subjects.forEach((subject) => {
    const option = document.createElement("option");
    option.value = subject;
    option.textContent = subject;
    option.selected = subject === selected;
    subjectFilter.appendChild(option);
  });
}

function refresh(params = {}) {
  applyFilters(params);
  renderResources();
  renderSubjects();
  updateSessionUI();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      reject(new Error("For this browser demo, files must be 4 MB or smaller."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

document.querySelector("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const email = String(formData.get("email")).trim().toLowerCase();
  const password = String(formData.get("password"));

  if (!email || !password) {
    showToast("Enter any email and password to continue.");
    return;
  }

  let user = state.users.find((item) => item.email === email);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      name: email.split("@")[0] || "Student",
      email,
      password,
      role: email === "admin@studyshare.local" ? "admin" : "student",
      createdAt: new Date().toISOString()
    };
    state.users.push(user);
    saveState();
  }

  currentUserId = user.id;
  sessionStorage.setItem("studyshare_current_user", currentUserId);
  event.target.reset();
  refresh();
  showToast("Logged in successfully.");
});

document.querySelector("#signupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const name = String(formData.get("name")).trim();
  const email = String(formData.get("email")).trim().toLowerCase();
  const password = String(formData.get("password"));

  if (!name || !email || !password) {
    showToast("Enter any name, email, and password to continue.");
    return;
  }

  let user = state.users.find((item) => item.email === email);
  if (user) {
    user.name = name;
    user.password = password;
  } else {
    user = {
      id: crypto.randomUUID(),
      name,
      email,
      password,
      role: email === "admin@studyshare.local" ? "admin" : "student",
      createdAt: new Date().toISOString()
    };
    state.users.push(user);
  }

  saveState();
  currentUserId = user.id;
  sessionStorage.setItem("studyshare_current_user", currentUserId);
  event.target.reset();
  refresh();
  showToast("Account created.");
});

logoutBtn.addEventListener("click", () => {
  currentUserId = null;
  sessionStorage.removeItem("studyshare_current_user");
  refresh();
  showToast("Logged out.");
});

document.querySelector("#resourceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentUser = getCurrentUser();
  if (!currentUser) {
    showToast("Please log in first.");
    return;
  }

  try {
    const formData = new FormData(event.target);
    const file = formData.get("file");
    const link = String(formData.get("link") || "").trim();
    const fileData = file && file.size ? await readFileAsDataUrl(file) : "";

    if (!fileData && !link) {
      showToast("Upload a file or provide a useful link.");
      return;
    }

    state.resources.push({
      id: crypto.randomUUID(),
      title: String(formData.get("title")).trim(),
      subject: String(formData.get("subject")).trim(),
      description: String(formData.get("description")).trim(),
      link,
      fileName: fileData ? file.name : "",
      fileData,
      uploaderId: currentUser.id,
      uploaderName: currentUser.name,
      createdAt: new Date().toISOString()
    });
    saveState();
    event.target.reset();
    refresh();
    showToast("Resource shared.");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  refresh(Object.fromEntries(formData));
});

adminList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;

  if (!confirm("Remove this resource?")) return;
  state.resources = state.resources.filter((resource) => resource.id !== button.dataset.delete);
  saveState();
  refresh();
  showToast("Resource removed.");
});

refresh();
