// auth strings in English: the source every other language follows.

export default {
  error: "An error occurred",
  email: "Email",
  password: "Password",
  name: "Name",
  namePlaceholder: "Ada Lovelace",
  enterName: "Enter your name",
  signIn: "Sign in",
  signOut: "Sign out",
  checkEmail: "Check your email",
  login: {
    title: "Welcome to Richelieu",
    description: "Sign in to build apps by describing them.",
    forgot: "Forgot it?",
    noAccount: "No account yet?",
    signUp: "Sign up",
  },
  signUp: {
    title: "Create your account",
    description: "Describe an app, and watch Richelieu build it.",
    repeatPassword: "Repeat the password",
    submit: "Create the account",
    passwordsMismatch: "Passwords do not match",
    confirm: "Confirm your account from the link we sent, then sign in.",
    haveAccount: "Already have an account?",
  },
  forgot: {
    title: "Reset your password",
    description: "Enter your email, and we will send you a link to choose a new one.",
    submit: "Send the link",
    remembered: "Remembered it?",
    sent: "If an account uses this address, a link to reset its password is on its way.",
    backToSignIn: "Back to sign in",
  },
  update: {
    title: "Choose a new password",
    description: "You will stay signed in with it.",
    newPassword: "New password",
    submit: "Save the password",
  },
  nameForm: {
    title: "What is your name?",
    description: "Your name shows at the bottom of the sidebar.",
    submit: "Save your name",
  },
} as const;
