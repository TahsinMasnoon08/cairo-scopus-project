const SUPABASE_URL = "https://fpkwfshlhxuicxjrhqyu.supabase.co";
const SUPABASE_KEY = "sb_publishable_CbxJjQY_JYsV1Dblo_08sg_Xp7G4zM6";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function signUp() {
  const fullName = document.getElementById("fullName").value;
  const email = document.getElementById("signupEmail").value;
  const password = document.getElementById("signupPassword").value;

  const { data, error } = await supabaseClient.auth.signUp({
    email: email,
    password: password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  const user = data.user;

  if (user) {
    const { error: profileError } = await supabaseClient
      .from("profiles")
      .insert([
        {
          id: user.id,
          full_name: fullName,
          email: email,
          role: "user",
        },
      ]);

    if (profileError) {
      alert(profileError.message);
      return;
    }
  }

  alert("Signup successful! Please login.");
  window.location.href = "login.html";
}

async function login() {
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  const user = data.user;

  const { data: profile, error: profileError } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError) {
    alert(profileError.message);
    return;
  }

  if (profile.role === "admin") {
    window.location.href = "admin.html";
  } else {
    window.location.href = "home.html";
  }
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = "login.html";
}