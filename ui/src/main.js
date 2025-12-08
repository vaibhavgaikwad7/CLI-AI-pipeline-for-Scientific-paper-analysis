const runBtn = document.getElementById("runBtn");
const output = document.getElementById("output");

runBtn.addEventListener("click", async () => {
  const file = document.getElementById("pdfInput").files[0];
  const provider = document.getElementById("provider").value;
  const model = document.getElementById("model").value;

  if (!file) {
    alert("Please select a PDF file first.");
    return;
  }

  output.textContent = "Processing...";

  const form = new FormData();
  form.append("pdf", file);
  form.append("provider", provider);
  form.append("model", model);

  try {
    const res = await fetch("http://localhost:8080/process", {
      method: "POST",
      body: form,
    });

    const json = await res.json();
    output.textContent = JSON.stringify(json, null, 2);
  } catch (err) {
    output.textContent = "Error: " + err.message;
  }
});
