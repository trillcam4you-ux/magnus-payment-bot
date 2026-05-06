import pandas as pd
from fpdf import FPDF


def main() -> None:
    data = {
        "Name": ["Victim"],
        "Account Number": ["123456789"],
        "Compromised Amount": ["$10,000"],
    }
    df = pd.DataFrame(data)

    pdf_obj = FPDF()
    pdf_obj.add_page()

    pdf_obj.set_font("Arial", "B", 15)
    pdf_obj.cell(0, 10, "Subject: Bank Account Compromise - Victim", ln=True)
    pdf_obj.ln(5)

    pdf_obj.set_font("Arial", "", 12)
    pdf_obj.cell(0, 10, "To Whom It May Concern,", ln=True)
    pdf_obj.ln(3)

    amount = df.loc[0, "Compromised Amount"]
    body_text = (
        f"We have discovered that {amount} has been compromised in this incident. "
        "We request your immediate attention to this matter and anticipate your swift "
        "action to address the security concerns at hand."
    )
    pdf_obj.multi_cell(0, 8, body_text)
    pdf_obj.ln(5)

    pdf_obj.set_font("Arial", "B", 12)
    pdf_obj.cell(0, 10, "Incident Details:", ln=True)
    pdf_obj.set_font("Arial", "", 12)
    pdf_obj.cell(0, 8, f"Name: {df.loc[0, 'Name']}", ln=True)
    pdf_obj.cell(0, 8, f"Account Number: {df.loc[0, 'Account Number']}", ln=True)
    pdf_obj.cell(0, 8, f"Compromised Amount: {amount}", ln=True)

    output_path = "bank_account_compromise.pdf"
    pdf_obj.output(output_path)
    print(f"PDF created: {output_path}")


if __name__ == "__main__":
    main()
