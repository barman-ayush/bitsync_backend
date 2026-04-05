import { Request, Response } from 'express';

export class AuthController {
    static async register(req : Request , res : Response) : Promise<void> {
        try{
            res.status(200).json({
                success : true
            })     
        }catch(e){
            res.status(404).json({
                success : false
            })     
        }
    }
}